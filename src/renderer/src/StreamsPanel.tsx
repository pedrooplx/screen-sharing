import { useEffect, useRef, useState, type RefObject } from 'react';
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

  // A floating, always-on-top window the user can freely move and resize by
  // dragging its edges - unlike Element.requestFullscreen(), which always
  // takes over the entire screen at a fixed size and hides everything else.
  // Falls back to fullscreen only if the platform genuinely has no
  // Picture-in-Picture (document.pictureInPictureEnabled false).
  const maximize = () => {
    const el = ref.current;
    if (!el) return;
    if (document.pictureInPictureEnabled && !el.disablePictureInPicture) {
      void el
        .requestPictureInPicture()
        .catch((err: Error) => console.error('requestPictureInPicture failed:', err));
    } else {
      // requires the 'fullscreen' permission granted in src/main/index.ts's
      // setPermissionRequestHandler - without it this rejects silently.
      void el.requestFullscreen().catch((err: Error) => console.error('requestFullscreen failed:', err));
    }
  };

  return (
    <div className="watch-tile">
      <div className="watch-video">
        {remote ? (
          <video
            ref={ref}
            autoPlay
            playsInline
            onDoubleClick={maximize}
            title="Clique duas vezes para abrir numa janela flutuante"
          />
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
        <span className="name">{owner}</span>
        <span className="watch-actions">
          {remote && (
            <button className="ghost" onClick={maximize} title="Abrir numa janela flutuante">
              🗗
            </button>
          )}
          {watching ? (
            <button className="ghost" onClick={() => media.unsubscribe(stream.streamId)}>
              Parar
            </button>
          ) : (
            <button className="primary" onClick={() => void media.subscribe(stream.streamId)}>
              Assistir
            </button>
          )}
        </span>
      </div>
      {remote && stream.audio && <VolumeControl videoRef={ref} />}
    </div>
  );
}

function VolumeControl({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [videoRef, volume, muted]);

  const icon = muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';

  return (
    <div className="volume-control">
      <button
        className="icon-btn"
        onClick={() => setMuted((m) => !m)}
        title={muted ? 'Ativar som' : 'Mudo'}
      >
        {icon}
      </button>
      <input
        type="range"
        className="volume-slider"
        min={0}
        max={100}
        value={Math.round((muted ? 0 : volume) * 100)}
        onChange={(e) => {
          const next = Number(e.target.value) / 100;
          setVolume(next);
          if (next > 0 && muted) setMuted(false);
        }}
        title="Volume da transmissão"
      />
    </div>
  );
}
