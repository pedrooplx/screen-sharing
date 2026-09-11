import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from 'werift';
import { SfuRouter, SfuError } from '../../src/main/sfu/router.js';

const codecs = {
  video: [
    new RTCRtpCodecParameters({
      mimeType: 'video/VP8',
      clockRate: 90000,
      rtcpFeedback: [
        { type: 'nack' },
        { type: 'nack', parameter: 'pli' },
      ],
      payloadType: 96,
    }),
  ],
};

let routers: SfuRouter[] = [];
let pcs: RTCPeerConnection[] = [];

afterEach(() => {
  for (const r of routers) r.close();
  for (const pc of pcs) {
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }
  routers = [];
  pcs = [];
});

function clientPc(): RTCPeerConnection {
  const pc = new RTCPeerConnection({ codecs });
  pcs.push(pc);
  return pc;
}

const until = async (pred: () => boolean, ms = 8000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 40));
  }
};

/** A werift peer that publishes a synthetic 30fps video stream to the SFU. */
async function publish(
  router: SfuRouter,
  peerId: string,
  streamId: string,
): Promise<() => void> {
  const pc = clientPc();
  const track = new MediaStreamTrack({ kind: 'video' });
  pc.addTransceiver(track, { direction: 'sendonly' });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIce(pc);

  const { answerSdp } = await router.publish(peerId, streamId, pc.localDescription!.sdp, {
    video: true,
    audio: false,
  });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  let seq = 0;
  let ts = 0;
  const timer = setInterval(() => {
    ts += 3000;
    const header = new RtpHeader({
      sequenceNumber: seq++ & 0xffff,
      timestamp: ts >>> 0,
      payloadType: 96,
      ssrc: 0xaabbccdd,
      marker: true,
    });
    try {
      track.writeRtp(new RtpPacket(header, Buffer.alloc(200, 9)));
    } catch {
      /* not connected yet */
    }
  }, 33);
  return () => clearInterval(timer);
}

async function subscribe(
  router: SfuRouter,
  peerId: string,
  streamId: string,
): Promise<{ received: () => number }> {
  const pc = clientPc();
  let received = 0;
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      received++;
    });
  });

  const { offerSdp } = await router.subscribe(peerId, streamId);
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIce(pc);
  await router.completeSubscribe(peerId, streamId, pc.localDescription!.sdp);

  return { received: () => received };
}

function waitIce(pc: RTCPeerConnection, ms = 4000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pc.iceGatheringStateChange.subscribe((s: string) => {
      if (s === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe('SfuRouter', () => {
  it('forwards a publisher stream to one subscriber (werift <-> werift)', async () => {
    const router = new SfuRouter();
    routers.push(router);

    const stopPub = await publish(router, 'p_pub', 's1');
    expect(router.listStreams().map((s) => s.streamId)).toEqual(['s1']);

    const sub = await subscribe(router, 'p_sub', 's1');
    await until(() => sub.received() > 5);

    expect(sub.received()).toBeGreaterThan(5);
    expect(router.subscriberCount('s1')).toBe(1);
    stopPub();
  }, 20000);

  it('does not request a keyframe before the subscriber itself is connected', async () => {
    // Regression test: the SFU used to ask the publisher for a keyframe the
    // moment it saw the *next* RTP packet after subscribe() was called - a
    // request that can (and in practice, reliably does) land before this
    // brand-new subscriber's own ICE/DTLS setup is done, so the resulting
    // keyframe gets silently dropped and the subscriber never sees video.
    const router = new SfuRouter();
    routers.push(router);
    const stopPub = await publish(router, 'p_pub', 'keyframe-timing');

    // RTCRtpReceiver isn't exported from werift's package root; every
    // instance shares one prototype, so grabbing it off a throwaway receiver
    // lets us spy on the SFU's internal receiver towards the publisher too.
    const proto = Object.getPrototypeOf(clientPc().addTransceiver('video').receiver);
    const pliSpy = vi.spyOn(proto, 'sendRtcpPLI');

    try {
      const pc = clientPc();
      pc.onTrack.subscribe(() => {});
      const { offerSdp } = await router.subscribe('p_sub', 'keyframe-timing');
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc);

      // the publisher has been streaming continuously since publish() -
      // several packets have already crossed the SFU by now, but this
      // subscriber hasn't even sent its answer yet, so it cannot be
      // 'connected'.
      await new Promise((r) => setTimeout(r, 200));
      expect(pliSpy).not.toHaveBeenCalled();

      await router.completeSubscribe('p_sub', 'keyframe-timing', pc.localDescription!.sdp);
      await until(() => pc.connectionState === 'connected');
      await until(() => pliSpy.mock.calls.length > 0);
      expect(pliSpy).toHaveBeenCalled();
    } finally {
      pliSpy.mockRestore();
      stopPub();
    }
  }, 20000);

  it('rejects subscribing to an unknown stream', async () => {
    const router = new SfuRouter();
    routers.push(router);
    await expect(router.subscribe('p_x', 'ghost')).rejects.toThrow(SfuError);
  });

  it('rejects a duplicate publish of the same streamId', async () => {
    const router = new SfuRouter();
    routers.push(router);
    const stop = await publish(router, 'p_a', 'dup');
    await expect(
      router.publish('p_a', 'dup', 'v=0\r\n', { video: true, audio: false }),
    ).rejects.toThrow(SfuError);
    stop();
  }, 20000);

  it('unpublish ends the stream and tears down its subscriptions', async () => {
    const router = new SfuRouter();
    routers.push(router);
    const ended: string[] = [];
    router.on('stream-ended', ({ streamId }) => ended.push(streamId));

    const stop = await publish(router, 'p_a', 's2');
    await subscribe(router, 'p_b', 's2');
    expect(router.subscriberCount('s2')).toBe(1);

    router.unpublish('s2');
    expect(router.listStreams()).toHaveLength(0);
    expect(router.subscriberCount('s2')).toBe(0);
    expect(ended).toEqual(['s2']);
    stop();
  }, 20000);

  it('emits demand-changed as the subscriber count crosses 0<->1', async () => {
    const router = new SfuRouter();
    routers.push(router);
    const demand: number[] = [];
    router.on('demand-changed', ({ streamId, subscribers }) => {
      if (streamId === 'sd') demand.push(subscribers);
    });

    const stop = await publish(router, 'p_a', 'sd');
    await subscribe(router, 'p_b', 'sd');
    await subscribe(router, 'p_c', 'sd');
    router.unsubscribe('p_b', 'sd');
    router.unsubscribe('p_c', 'sd');

    expect(demand).toEqual([1, 2, 1, 0]);
    stop();
  }, 20000);

  it('two viewers watch two streams (2 publishers x 2 subscribers)', async () => {
    const router = new SfuRouter();
    routers.push(router);
    const stopA = await publish(router, 'p_a', 'ta');
    const stopB = await publish(router, 'p_b', 'tb');

    // p_c watches both
    const ca = await subscribe(router, 'p_c', 'ta');
    const cb = await subscribe(router, 'p_c', 'tb');
    await until(() => ca.received() > 3 && cb.received() > 3);

    expect(router.subscriberCount('ta')).toBe(1);
    expect(router.subscriberCount('tb')).toBe(1);
    stopA();
    stopB();
  }, 25000);

  it('removePeer drops both the peer\'s stream and its subscriptions', async () => {
    const router = new SfuRouter();
    routers.push(router);
    const stopA = await publish(router, 'p_a', 'sa');
    const stopB = await publish(router, 'p_b', 'sb');
    await subscribe(router, 'p_a', 'sb'); // a watches b

    router.removePeer('p_a');
    expect(router.listStreams().map((s) => s.streamId)).toEqual(['sb']);
    expect(router.subscriberCount('sb')).toBe(0);
    stopA();
    stopB();
  }, 20000);
});
