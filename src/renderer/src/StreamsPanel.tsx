import { useEffect, useRef } from 'react';
import type { StreamInfo } from '../../shared/ipc.js';
import type { RosterEntry } from '../../shared/ipc.js';
import type { MediaEngine } from './rtc.js';

export function StreamsPanel({
  media,
  streams,
  roster,
  selfPeerId,
}: {
  media: MediaEngine;
  streams: StreamInfo[];
  roster: RosterEntry[];
  selfPeerId: string;
}) {
  const others = streams.filter((s) => s.ownerPeerId !== selfPeerId);
  const nameOf = (peerId: string) =>
    roster.find((e) => e.peerId === peerId)?.nickname ?? 'alguém';

  if (others.length === 0) {
    return (
      <div className="card">
        <h2>Transmissões da sala</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Ninguém está transmitindo no momento.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Transmissões da sala ({others.length})</h2>
      <div className="watch-grid">
        {others.map((s) => (
          <WatchTile
            key={s.streamId}
            stream={s}
            owner={nameOf(s.ownerPeerId)}
            media={media}
          />
        ))}
      </div>
      {media.error && <div className="error">{media.error}</div>}
    </div>
  );
}

function WatchTile({
  stream,
  owner,
  media,
}: {
  stream: StreamInfo;
  owner: string;
  media: MediaEngine;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const remote = media.remote.get(stream.streamId) ?? null;
  const watching = media.isSubscribed(stream.streamId);

  useEffect(() => {
    const el = ref.current;
    if (el && remote) {
      el.srcObject = remote;
      void el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [remote]);

  return (
    <div className="watch-tile">
      <div className="watch-video">
        {remote ? (
          <video ref={ref} autoPlay playsInline />
        ) : (
          <div className="watch-placeholder">
            {watching ? (
              <>
                <span className="spinner" />
                conectando…
              </>
            ) : (
              'não assistindo'
            )}
          </div>
        )}
      </div>
      <div className="watch-meta">
        <span className="name">
          {owner}
          {stream.audio ? ' 🔊' : ''}
        </span>
        {watching ? (
          <button className="ghost" onClick={() => media.unsubscribe(stream.streamId)}>
            Parar
          </button>
        ) : (
          <button className="primary" onClick={() => void media.subscribe(stream.streamId)}>
            Assistir
          </button>
        )}
      </div>
    </div>
  );
}
