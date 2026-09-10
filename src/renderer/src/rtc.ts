/**
 * The renderer's WebRTC layer (Chromium RTCPeerConnection) talking to the
 * host's werift SFU. Non-trickle: gather ICE, then send the SDP.
 *
 *   publish:   this peer is the offerer  (publish_offer -> publish_answer)
 *   subscribe: the SFU is the offerer    (subscribe -> subscribe_offer -> subscribe_answer)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaBody, StreamInfo } from '../../shared/ipc.js';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

async function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
}

export interface MediaEngine {
  readonly localStream: MediaStream | null;
  readonly localStreamId: string | null;
  /** true when the SFU told us to stop encoding (nobody watching) */
  readonly publishIdle: boolean;
  readonly remote: Map<string, MediaStream>;
  readonly watching: number;
  readonly error: string | null;
  publish(stream: MediaStream): Promise<void>;
  unpublish(): void;
  subscribe(streamId: string): Promise<void>;
  unsubscribe(streamId: string): void;
  isSubscribed(streamId: string): boolean;
}

export function useMedia(streams: StreamInfo[], epoch: number): MediaEngine {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localIdRef = useRef<string | null>(null);
  const publishStreamRef = useRef<MediaStream | null>(null);
  const publishPc = useRef<RTCPeerConnection | null>(null);
  const [publishIdle, setPublishIdle] = useState(false);
  const subPcs = useRef<Map<string, RTCPeerConnection>>(new Map());
  /** which owners we intend to watch - survives a failover (peerIds are stable) */
  const wantedOwners = useRef<Set<string>>(new Set());
  const [remote, setRemote] = useState<Map<string, MediaStream>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const setRemoteStream = useCallback((id: string, stream: MediaStream | null) => {
    setRemote((prev) => {
      const next = new Map(prev);
      if (stream) next.set(id, stream);
      else next.delete(id);
      return next;
    });
  }, []);

  const unpublish = useCallback(() => {
    const id = localIdRef.current;
    if (id) window.erros.sendMedia({ type: 'unpublish', streamId: id });
    publishPc.current?.close();
    publishPc.current = null;
    localIdRef.current = null;
    publishStreamRef.current = null;
    setPublishIdle(false);
    setLocalStream(null);
  }, []);

  const publish = useCallback(async (stream: MediaStream) => {
    unpublish();
    setError(null);
    const streamId = crypto.randomUUID();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    publishPc.current = pc;
    publishStreamRef.current = stream;
    localIdRef.current = streamId;

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gathered(pc);

    window.erros.sendMedia({
      type: 'publish_offer',
      streamId,
      video: stream.getVideoTracks().length > 0,
      audio: stream.getAudioTracks().length > 0,
      sdp: pc.localDescription!.sdp,
    });
    setLocalStream(stream);
  }, [unpublish]);

  const teardownSub = useCallback(
    (streamId: string) => {
      subPcs.current.get(streamId)?.close();
      subPcs.current.delete(streamId);
      setRemoteStream(streamId, null);
    },
    [setRemoteStream],
  );

  const startSub = useCallback((streamId: string) => {
    if (subPcs.current.has(streamId)) return;
    // placeholder PC so a double request doesn't double-subscribe
    subPcs.current.set(streamId, new RTCPeerConnection());
    rerender();
    window.erros.sendMedia({ type: 'subscribe', streamId });
  }, []);

  const unsubscribe = useCallback(
    (streamId: string) => {
      const owner = streams.find((s) => s.streamId === streamId)?.ownerPeerId;
      if (owner) wantedOwners.current.delete(owner);
      window.erros.sendMedia({ type: 'unsubscribe', streamId });
      teardownSub(streamId);
      rerender();
    },
    [streams, teardownSub],
  );

  const subscribe = useCallback(
    async (streamId: string) => {
      const owner = streams.find((s) => s.streamId === streamId)?.ownerPeerId;
      if (owner) wantedOwners.current.add(owner);
      setError(null);
      startSub(streamId);
    },
    [streams, startSub],
  );

  // handle media events from the main process
  useEffect(() => {
    return window.erros.onMedia((body: MediaBody) => {
      void handleMediaBody(body);
    });

    async function handleMediaBody(body: MediaBody): Promise<void> {
      switch (body.type) {
        case 'publish_answer': {
          if (localIdRef.current !== body.streamId || !publishPc.current) return;
          await publishPc.current
            .setRemoteDescription({ type: 'answer', sdp: body.sdp })
            .catch((e: Error) => setError(`publicação falhou: ${e.message}`));
          break;
        }
        case 'quality_directive': {
          if (localIdRef.current !== body.streamId || !publishPc.current) return;
          const pc = publishPc.current;
          const src = publishStreamRef.current;
          const idle = body.maxKbps === 0;
          for (const sender of pc.getSenders()) {
            const kind = sender.track?.kind ?? 'video';
            if (idle) {
              void sender.replaceTrack(null);
            } else if (src) {
              const track =
                sender.track ??
                (kind === 'audio'
                  ? src.getAudioTracks()[0]
                  : src.getVideoTracks()[0]) ??
                null;
              if (track && sender.track !== track) void sender.replaceTrack(track);
              if (kind === 'video') {
                const params = sender.getParameters();
                params.encodings = params.encodings?.length
                  ? params.encodings
                  : [{}];
                const enc = params.encodings[0]!;
                enc.maxBitrate = body.maxKbps * 1000;
                if (body.maxFps) enc.maxFramerate = body.maxFps;
                enc.scaleResolutionDownBy = body.scaleDownBy;
                void sender.setParameters(params).catch(() => {});
              }
            }
          }
          setPublishIdle(idle);
          break;
        }
        case 'subscribe_offer': {
          const stale = subPcs.current.get(body.streamId);
          stale?.close();
          const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          subPcs.current.set(body.streamId, pc);
          const inbound = new MediaStream();
          pc.addEventListener('track', (ev) => {
            inbound.addTrack(ev.track);
            setRemoteStream(body.streamId, inbound);
          });
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await gathered(pc);
            window.erros.sendMedia({
              type: 'subscribe_answer',
              streamId: body.streamId,
              sdp: pc.localDescription!.sdp,
            });
          } catch (e) {
            setError(`assinatura falhou: ${(e as Error).message}`);
            pc.close();
            subPcs.current.delete(body.streamId);
          }
          rerender();
          break;
        }
        case 'media_error': {
          setError(body.reason);
          if (localIdRef.current === body.streamId) unpublish();
          subPcs.current.get(body.streamId)?.close();
          subPcs.current.delete(body.streamId);
          setRemoteStream(body.streamId, null);
          rerender();
          break;
        }
        case 'stream_state': {
          if (body.state === 'ended') {
            subPcs.current.get(body.stream.streamId)?.close();
            subPcs.current.delete(body.stream.streamId);
            setRemoteStream(body.stream.streamId, null);
            rerender();
          }
          break;
        }
        default:
          break;
      }
    }
  }, [setRemoteStream, unpublish]);

  // reconcile subscriptions with the live stream list + our watch intent.
  // this is what re-subscribes after a failover: the owner peerIds are stable,
  // the streamIds change, so we follow the owner to its new stream.
  useEffect(() => {
    const live = new Set(streams.map((s) => s.streamId));
    const byOwner = new Map(streams.map((s) => [s.ownerPeerId, s.streamId]));

    // drop PCs whose stream is gone
    for (const id of [...subPcs.current.keys()]) {
      if (!live.has(id)) teardownSub(id);
    }
    // for every owner we want to watch, make sure we're on their current stream
    for (const owner of wantedOwners.current) {
      const streamId = byOwner.get(owner);
      if (!streamId) continue;
      const already = [...subPcs.current.keys()].some(
        (id) => streams.find((s) => s.streamId === id)?.ownerPeerId === owner,
      );
      if (!already) startSub(streamId);
    }
  }, [streams, teardownSub, startSub]);

  // on a host change (epoch bump) every PC points at a dead SFU - reset and
  // re-publish; the reconcile effect above re-subscribes.
  const prevEpoch = useRef(epoch);
  useEffect(() => {
    if (epoch === prevEpoch.current) return;
    prevEpoch.current = epoch;
    for (const id of [...subPcs.current.keys()]) teardownSub(id);
    const stream = publishStreamRef.current;
    const stillLive = stream?.getTracks().some((t) => t.readyState === 'live');
    publishPc.current?.close();
    publishPc.current = null;
    localIdRef.current = null;
    setPublishIdle(false);
    if (stream && stillLive) void publish(stream);
    rerender();
  }, [epoch, teardownSub, publish]);

  // periodic stats_report to the host's governor
  useEffect(() => {
    const prev = new Map<string, { lost: number; recv: number }>();
    const timer = setInterval(async () => {
      const subscriptions: Array<{
        streamId: string;
        fractionLost: number;
        jitterMs: number;
        rttMs: number;
        fps: number;
      }> = [];
      for (const [streamId, pc] of subPcs.current) {
        try {
          const rep = await pc.getStats();
          let lost = 0;
          let recv = 0;
          let jitterMs = 0;
          let fps = 0;
          let rttMs = 0;
          rep.forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') {
              lost = s.packetsLost ?? 0;
              recv = s.packetsReceived ?? 0;
              jitterMs = (s.jitter ?? 0) * 1000;
              fps = s.framesPerSecond ?? 0;
            }
            if (s.type === 'candidate-pair' && s.nominated) {
              rttMs = (s.currentRoundTripTime ?? 0) * 1000;
            }
          });
          const p = prev.get(streamId) ?? { lost: 0, recv: 0 };
          const dLost = Math.max(0, lost - p.lost);
          const dRecv = Math.max(0, recv - p.recv);
          prev.set(streamId, { lost, recv });
          subscriptions.push({
            streamId,
            fractionLost: dLost + dRecv > 0 ? dLost / (dLost + dRecv) : 0,
            jitterMs,
            rttMs,
            fps,
          });
        } catch {
          /* PC not ready */
        }
      }

      const publications: Array<{
        streamId: string;
        cpuPressure: number;
        fps: number;
      }> = [];
      const localId = localIdRef.current;
      if (localId && publishPc.current) {
        try {
          const rep = await publishPc.current.getStats();
          let fps = 0;
          let cpu = 0;
          rep.forEach((s) => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
              fps = s.framesPerSecond ?? 0;
              cpu = s.qualityLimitationReason === 'cpu' ? 1 : 0;
            }
          });
          publications.push({ streamId: localId, cpuPressure: cpu, fps });
        } catch {
          /* ignore */
        }
      }

      if (subscriptions.length || publications.length) {
        window.erros.sendMedia({ type: 'stats_report', subscriptions, publications });
      }
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  // teardown on unmount
  useEffect(
    () => () => {
      publishPc.current?.close();
      for (const pc of subPcs.current.values()) pc.close();
      subPcs.current.clear();
    },
    [],
  );

  return {
    localStream,
    localStreamId: localIdRef.current,
    publishIdle,
    remote,
    watching: subPcs.current.size,
    error,
    publish,
    unpublish,
    subscribe,
    unsubscribe,
    isSubscribed: (id: string) => subPcs.current.has(id),
  };
}
