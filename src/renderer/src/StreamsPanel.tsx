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
  const homeRef = useRef<HTMLDivElement | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const remote = media.remote.get(stream.streamId) ?? null;
  const watching = media.isSubscribed(stream.streamId);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.srcObject = remote;
      if (remote) void el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [remote]);

  // The <video> below is always mounted (never swapped for the placeholder
  // in JSX) precisely so this works: while floating, the real DOM node lives
  // inside the detached PiP document, not under homeRef. If React ever tried
  // to unmount/remount that exact node from here it would throw (it's not
  // actually a child of this container anymore). Closing the window first
  // restores the node home before anything else touches the tree.
  useEffect(() => {
    if (!remote) pipWindowRef.current?.close();
  }, [remote]);
  useEffect(() => () => pipWindowRef.current?.close(), []);

  const restoreHome = () => {
    const el = ref.current;
    const home = homeRef.current;
    if (el && home && el.parentElement !== home) home.appendChild(el);
    pipWindowRef.current = null;
  };

  // A real floating window the user can resize freely, including all the
  // way up to the full screen - unlike a plain video requestPictureInPicture(),
  // which Chromium caps at roughly 80% of the screen's work area no matter
  // how far you drag it. documentPictureInPicture opens an actual auxiliary
  // window and lets us move the live <video> node into it directly (per
  // Chrome's own documented pattern), so playback never interrupts.
  // Falls back to basic video PiP, then to fullscreen, on older Chromium.
  const maximize = async () => {
    const el = ref.current;
    if (!el) return;
    const docPip = window.documentPictureInPicture;
    if (docPip) {
      try {
        const pipWindow = await docPip.requestWindow({ width: 960, height: 540 });
        Object.assign(pipWindow.document.body.style, {
          margin: '0',
          background: '#000',
          height: '100vh',
          overflow: 'hidden',
        });
        Object.assign(el.style, { width: '100%', height: '100%', objectFit: 'contain' });
        pipWindow.document.body.append(el);
        const closeBtn = pipWindow.document.createElement('button');
        closeBtn.textContent = '✕';
        Object.assign(closeBtn.style, {
          position: 'fixed',
          top: '8px',
          right: '8px',
          border: 'none',
          borderRadius: '6px',
          background: 'rgba(0,0,0,0.55)',
          color: '#fff',
          width: '28px',
          height: '28px',
          cursor: 'pointer',
          font: '14px/1 sans-serif',
        });
        closeBtn.onclick = () => pipWindow.close();
        pipWindow.document.body.append(closeBtn);
        pipWindowRef.current = pipWindow;
        pipWindow.addEventListener(
          'pagehide',
          () => {
            el.style.removeProperty('width');
            el.style.removeProperty('height');
            el.style.removeProperty('object-fit');
            restoreHome();
          },
          { once: true },
        );
        return;
      } catch (err) {
        console.error('documentPictureInPicture failed:', err);
      }
    }
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
      <div className="watch-video" ref={homeRef}>
        <video
          ref={ref}
          autoPlay
          playsInline
          hidden={!remote}
          onDoubleClick={remote ? () => void maximize() : undefined}
          title="Clique duas vezes para abrir numa janela flutuante"
        />
        {!remote && (
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
            <button className="ghost" onClick={() => void maximize()} title="Abrir numa janela flutuante">
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
