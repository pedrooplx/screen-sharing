import { afterEach, describe, expect, it } from 'vitest';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from 'werift';
import { SfuMediaPlane } from '../../src/main/sfu/media-plane.js';
import type { MediaBody } from '../../src/shared/ipc.js';

const codecs = {
  video: [
    new RTCRtpCodecParameters({
      mimeType: 'video/VP8',
      clockRate: 90000,
      rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }],
      payloadType: 96,
    }),
  ],
};

let planes: SfuMediaPlane[] = [];
let pcs: RTCPeerConnection[] = [];
afterEach(() => {
  for (const p of planes) p.close();
  for (const pc of pcs) {
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }
  planes = [];
  pcs = [];
});

function waitIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, 3000);
    pc.iceGatheringStateChange.subscribe((s: string) => {
      if (s === 'complete') {
        clearTimeout(t);
        r();
      }
    });
  });
}

async function publish(plane: SfuMediaPlane, peerId: string, streamId: string) {
  const pc = new RTCPeerConnection({ codecs });
  pcs.push(pc);
  pc.addTransceiver(new MediaStreamTrack({ kind: 'video' }), { direction: 'sendonly' });
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  const answer = await plane.handleMessage(peerId, {
    type: 'publish_offer',
    streamId,
    video: true,
    audio: false,
    sdp: pc.localDescription!.sdp,
  });
  await pc.setRemoteDescription({ type: 'answer', sdp: (answer as { sdp: string }).sdp });
  return pc;
}

async function subscribe(plane: SfuMediaPlane, peerId: string, streamId: string) {
  const pc = new RTCPeerConnection({ codecs });
  pcs.push(pc);
  const offer = (await plane.handleMessage(peerId, { type: 'subscribe', streamId })) as {
    sdp: string;
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc);
  await plane.handleMessage(peerId, {
    type: 'subscribe_answer',
    streamId,
    sdp: pc.localDescription!.sdp,
  });
  return pc;
}

describe('SfuMediaPlane', () => {
  it('broadcasts stream_state live/ended and lists streams', async () => {
    const plane = new SfuMediaPlane();
    planes.push(plane);
    const broadcasts: MediaBody[] = [];
    plane.attachBroadcast((b) => broadcasts.push(b));

    await publish(plane, 'p_a', 's1');
    expect(plane.listStreams().map((s) => s.streamId)).toEqual(['s1']);
    expect(broadcasts.some((b) => b.type === 'stream_state' && b.state === 'live')).toBe(true);

    await plane.handleMessage('p_a', { type: 'unpublish', streamId: 's1' });
    expect(plane.listStreams()).toHaveLength(0);
    expect(broadcasts.some((b) => b.type === 'stream_state' && b.state === 'ended')).toBe(true);
  }, 20000);

  it('sends quality_directive to the owner as viewers come and go', async () => {
    const plane = new SfuMediaPlane({ videoBitrateKbps: 3000 });
    planes.push(plane);
    const directives: MediaBody[] = [];
    plane.attachSendTo((peerId, body) => {
      if (peerId === 'p_a') directives.push(body);
    });

    await publish(plane, 'p_a', 's1');
    await subscribe(plane, 'p_b', 's1');
    await plane.handleMessage('p_b', { type: 'unsubscribe', streamId: 's1' });

    const q = directives.filter((d) => d.type === 'quality_directive');
    expect(q).toEqual([
      expect.objectContaining({ maxKbps: 3000, reason: 'restored' }),
      expect.objectContaining({ maxKbps: 0, reason: 'no_viewers' }),
    ]);
  }, 20000);

  it('returns a media_error for a bad subscribe', async () => {
    const plane = new SfuMediaPlane();
    planes.push(plane);
    const reply = await plane.handleMessage('p_x', { type: 'subscribe', streamId: 'ghost' });
    expect(reply?.type).toBe('media_error');
  });
});
