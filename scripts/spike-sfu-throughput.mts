// @ts-nocheck  -- exploratory spike, run via tsx (not part of the typechecked build)
/**
 * Fase 1 - spike de validação do SFU (docs/DESIGN.md secao 14, risco 1 e §15).
 *
 * Pergunta que este spike responde: o encaminhamento de RTP + SRTP em JS puro
 * (werift) aguenta o pior caso de ~7.000 pacotes/s de um host doméstico?
 *
 * O que ele faz:
 *   1 publisher werift  --RTP sintético 2,5 Mbps / 30 fps-->  SFU werift
 *   SFU reescreve só o cabeçalho RTP (SSRC + offset de seq/ts) e reenvia
 *   para N subscribers werift, SEM decodificar nem recodificar.
 *   Mede: pacotes/s de entrada, pacotes/s de saída somados, perda, e
 *   process.cpuUsage() do processo do SFU.
 *
 * O que ele NÃO valida: interoperabilidade de negociação com o Chromium. Isso
 * só dá para testar de verdade na Fase 3, com um renderer Electron real
 * capturando tela. Este spike isola a questão quantitativa (CPU/throughput).
 *
 * Uso:
 *   npx tsx scripts/spike-sfu-throughput.mts [--subs=4] [--seconds=20] [--kbps=2500]
 */

import { performance } from 'node:perf_hooks';
import {
  MediaStreamTrack,
  RtpHeader,
  RtpPacket,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from 'werift';

const VIDEO_CODEC = new RTCRtpCodecParameters({
  mimeType: 'video/VP8',
  clockRate: 90000,
  payloadType: 96,
});

const pc = () =>
  new RTCPeerConnection({ codecs: { video: [VIDEO_CODEC] } });

interface Args {
  subs: number;
  seconds: number;
  kbps: number;
  fps: number;
}

function parseArgs(): Args {
  const get = (name: string, def: number) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : def;
  };
  return {
    subs: get('subs', 4),
    seconds: get('seconds', 20),
    kbps: get('kbps', 2500),
    fps: get('fps', 30),
  };
}

async function connect(a: RTCPeerConnection, b: RTCPeerConnection): Promise<void> {
  a.onIceCandidate.subscribe((c) => b.addIceCandidate(c.toJSON()));
  b.onIceCandidate.subscribe((c) => a.addIceCandidate(c.toJSON()));
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(a.localDescription!);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(b.localDescription!);
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `spike: ${args.subs} subscribers, ${args.seconds}s, ${args.kbps} kbps @ ${args.fps} fps`,
  );

  // --- publisher -> SFU -------------------------------------------------
  const publisher = pc();
  const sfuInbound = pc();
  const source = new MediaStreamTrack({ kind: 'video' });
  publisher.addTransceiver(source, { direction: 'sendonly' });

  let inbound = 0;
  const forwarders: Array<(p: RtpPacket) => void> = [];
  sfuInbound.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      inbound++;
      for (const fwd of forwarders) fwd(rtp);
    });
  });
  await connect(publisher, sfuInbound);

  // --- SFU -> N subscribers -------------------------------------------
  let outbound = 0;
  let received = 0;
  for (let i = 0; i < args.subs; i++) {
    const sfuOutbound = pc();
    const subscriber = pc();
    const relay = new MediaStreamTrack({ kind: 'video' });
    sfuOutbound.addTransceiver(relay, { direction: 'sendonly' });
    subscriber.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe(() => received++);
    });
    await connect(sfuOutbound, subscriber);

    let warned = false;
    forwarders.push((rtp) => {
      try {
        // real SFU work: hand the packet to a different SRTP context, which
        // re-serializes and re-encrypts it for this subscriber.
        relay.writeRtp(rtp);
        outbound++;
      } catch (err) {
        if (!warned) {
          warned = true;
          console.error('forward error:', (err as Error).message);
        }
      }
    });
  }
  // let the SFU->subscriber senders bind their codec before traffic starts
  await new Promise((r) => setTimeout(r, 500));

  // --- synthetic 2.5 Mbps / 30 fps source ----------------------------
  const bytesPerSecond = (args.kbps * 1000) / 8;
  const packetsPerFrame = Math.max(
    1,
    Math.round(bytesPerSecond / args.fps / 1100),
  );
  const payload = Buffer.alloc(1100, 7);
  let seq = 0;
  let timestamp = 0;

  const frameTimer = setInterval(() => {
    timestamp += 90000 / args.fps;
    for (let p = 0; p < packetsPerFrame; p++) {
      const header = new RtpHeader({
        sequenceNumber: seq++ & 0xffff,
        timestamp: timestamp >>> 0,
        payloadType: 96,
        ssrc: 0xcafe,
        marker: p === packetsPerFrame - 1,
      });
      source.writeRtp(new RtpPacket(header, payload));
    }
  }, 1000 / args.fps);

  // warm up 2 s (DTLS/ICE settle), then measure only the steady-state window
  await new Promise((r) => setTimeout(r, 2000));
  const inAtStart = inbound;
  const outAtStart = outbound;
  const recvAtStart = received;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  await new Promise((r) => setTimeout(r, args.seconds * 1000));
  clearInterval(frameTimer);
  await new Promise((r) => setTimeout(r, 300));

  const wallSec = (performance.now() - wallStart) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const cpuSec = (cpu.user + cpu.system) / 1e6;
  const inboundWindow = inbound - inAtStart;
  const outboundWindow = outbound - outAtStart;
  const receivedWindow = received - recvAtStart;

  console.log('\n--- resultados ---');
  console.log(`entrada no SFU : ${(inboundWindow / wallSec).toFixed(0)} pkt/s`);
  console.log(
    `saída do SFU   : ${(outboundWindow / wallSec).toFixed(0)} pkt/s (${args.subs}x fan-out)`,
  );
  console.log(
    `recebidos      : ${receivedWindow} / ${outboundWindow} (perda ${(
      (1 - receivedWindow / Math.max(1, outboundWindow)) *
      100
    ).toFixed(2)}%)`,
  );
  console.log(
    `CPU do processo: ${cpuSec.toFixed(1)}s em ${wallSec.toFixed(
      1,
    )}s de wall = ${((cpuSec / wallSec) * 100).toFixed(0)}% de um núcleo`,
  );
  console.log(
    `\nprojeção pior caso (2 transmissores x 12 = ~6.200 pkt/s de saída):`,
  );
  const perPacketUs = (cpuSec * 1e6) / Math.max(1, inboundWindow + outboundWindow);
  console.log(`  ~${perPacketUs.toFixed(1)} µs/pacote  ->  ${(
    (perPacketUs * 6200) /
    1e4
  ).toFixed(1)}% de um núcleo para 6.200 pkt/s`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
