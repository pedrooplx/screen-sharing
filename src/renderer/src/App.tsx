import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshot } from '../../shared/ipc.js';
import type { RosterEntry } from '../../shared/protocol.js';
import { CapturePanel } from './CapturePanel.js';
import { StreamsPanel, VolumeControl } from './StreamsPanel.js';
import { useMedia, type MediaEngine } from './rtc.js';

const IDLE: SessionSnapshot = {
  phase: 'idle',
  isHost: false,
  selfPeerId: '',
  nickname: '',
  epoch: 0,
  code: null,
  roster: [],
  streams: [],
  maxRecommendedSubscriptions: 2,
  notice: null,
};

export function App() {
  const [snap, setSnap] = useState<SessionSnapshot>(IDLE);

  useEffect(() => {
    if (!window.erros) return;
    window.erros.getSnapshot().then(setSnap);
    return window.erros.onUpdate(setSnap);
  }, []);

  if (!window.erros) {
    return (
      <div className="app">
        <div className="brand">
          <b>erros-share</b>
        </div>
        <div className="notice">
          Abra pela aplicação (a ponte com o processo principal não está
          disponível fora do Electron).
        </div>
      </div>
    );
  }

  return <Connected snap={snap} />;
}

/**
 * Split out from App so useMedia() (and everything downstream of it) only
 * ever runs once window.erros is known to exist - App's own early return
 * above happens before this component is even mounted, so that guard never
 * has to be re-checked here.
 */
function Connected({ snap }: { snap: SessionSnapshot }) {
  const media = useMedia(snap.streams, snap.epoch);
  const [floatingStreamId, setFloatingStreamId] = useState<string | null>(null);

  const restore = useCallback(() => {
    setFloatingStreamId(null);
    void window.erros.setFloating(false);
  }, []);

  const float = useCallback((streamId: string) => {
    setFloatingStreamId(streamId);
    void window.erros.setFloating(true);
  }, []);

  // the owner ended their stream while we were floating it - don't leave the
  // widget stuck on a frozen frame with no way to tell it's dead.
  useEffect(() => {
    if (floatingStreamId && !media.remote.get(floatingStreamId)) restore();
  }, [floatingStreamId, media.remote, restore]);

  // Esc is the conventional way out of a floating/PiP-like view.
  useEffect(() => {
    if (!floatingStreamId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') restore();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floatingStreamId, restore]);

  if (floatingStreamId) {
    const owner =
      snap.roster.find(
        (e) => e.peerId === snap.streams.find((s) => s.streamId === floatingStreamId)?.ownerPeerId,
      )?.nickname ?? 'alguém';
    return (
      <FloatingVideo
        stream={media.remote.get(floatingStreamId) ?? null}
        owner={owner}
        onRestore={restore}
      />
    );
  }

  const inRoom = snap.phase === 'in-room' || snap.phase === 'hosting';

  return (
    <div className="app">
      <div className="brand">
        <b>erros-share</b> — compartilhamento de tela P2P
      </div>
      {snap.notice && <div className="notice">{snap.notice}</div>}
      {inRoom ? (
        <Room snap={snap} media={media} onFloat={float} />
      ) : (
        <Lobby phase={snap.phase} />
      )}
    </div>
  );
}

/**
 * Full-bleed view shown while the app's own window is shrunk into a small,
 * resizable, always-on-top widget (see main's IPC.setFloating handler) - a
 * real OS window has no platform-imposed size ceiling, unlike video
 * Picture-in-Picture (Chromium caps that around 80% of the screen) or
 * Document Picture-in-Picture (unsupported in this Electron build - its
 * requestWindow() never settles, which is why the button did nothing before).
 */
function FloatingVideo({
  stream,
  owner,
  onRestore,
}: {
  stream: MediaStream | null;
  owner: string;
  onRestore: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.srcObject = stream;
      if (stream) void el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="floating-video">
      <video ref={ref} autoPlay playsInline />
      <span className="floating-name">{owner}</span>
      <button className="floating-restore" onClick={onRestore} title="Restaurar (Esc)">
        ⤢
      </button>
      {stream && stream.getAudioTracks().length > 0 && <VolumeControl videoRef={ref} />}
    </div>
  );
}

function Lobby({ phase }: { phase: SessionSnapshot['phase'] }) {
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'host' | 'join'>(null);
  const [error, setError] = useState<string | null>(null);

  const connecting = phase === 'connecting' || phase === 'waking';
  const working = busy !== null || connecting;

  const host = async () => {
    setError(null);
    setBusy('host');
    const res = await window.erros.hostRoom({ nickname, password });
    if (!res.ok) setError(res.error);
    setBusy(null);
  };
  const join = async () => {
    setError(null);
    setBusy('join');
    const res = await window.erros.joinRoom({ nickname, password, code });
    if (!res.ok) setError(res.error);
    setBusy(null);
  };
  // a cold-start retry can take up to ~75 s (docs/DESIGN.md §18.4) - let the
  // user back out instead of staring at a frozen button the whole time.
  // RoomSession.leave() mid-connect closes whatever was just opened instead
  // of leaving it dangling, so this is always safe to fire.
  const cancel = () => {
    void window.erros.leaveRoom();
    setBusy(null);
  };

  return (
    <>
      <div className="card">
        <div className="field">
          <label htmlFor="nick">Seu apelido nesta sessão</label>
          <input
            id="nick"
            value={nickname}
            maxLength={48}
            placeholder="ex.: pedro"
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        <h2>Criar uma sala</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Seu PC coordena a sessão. Você recebe um código para compartilhar.
        </p>
        <div className="field">
          <label htmlFor="pw-host">Senha da sala</label>
          <input
            id="pw-host"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          className="primary"
          disabled={working || !nickname.trim() || !password}
          onClick={host}
        >
          {busy === 'host' || (connecting && busy === null) ? (
            <>
              <span className="spinner" />
              {phase === 'waking' ? 'Acordando o servidor…' : 'Conectando…'}
            </>
          ) : (
            'Criar sala'
          )}
        </button>
        {busy === 'host' && connecting && (
          <button className="ghost" style={{ marginTop: 8 }} onClick={cancel}>
            Cancelar
          </button>
        )}
      </div>

      <div className="card">
        <h2>Entrar numa sala</h2>
        <div className="field">
          <label htmlFor="code">Código da sala</label>
          <input
            id="code"
            value={code}
            placeholder="K7QM4X2-A9BTR0F-DW6HJE3"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pw-join">Senha da sala</label>
          <input
            id="pw-join"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          className="primary"
          disabled={working || !nickname.trim() || !password || !code.trim()}
          onClick={join}
        >
          {busy === 'join' || (connecting && busy === null) ? (
            <>
              <span className="spinner" />
              {phase === 'waking' ? 'Acordando o servidor…' : 'Conectando…'}
            </>
          ) : (
            'Entrar'
          )}
        </button>
        {busy === 'join' && connecting && (
          <button className="ghost" style={{ marginTop: 8 }} onClick={cancel}>
            Cancelar
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
    </>
  );
}

function Room({
  snap,
  media,
  onFloat,
}: {
  snap: SessionSnapshot;
  media: MediaEngine;
  onFloat: (streamId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const copy = useCallback(async () => {
    if (!snap.code) return;
    // Electron's native clipboard via IPC, not navigator.clipboard - the
    // renderer's permission handler only grants media/display-capture, so
    // the web Clipboard API rejects here and this used to silently "succeed".
    const res = await window.erros.copyToClipboard(snap.code);
    if (!res.ok) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [snap.code]);

  const leave = () => void window.erros.leaveRoom();

  return (
    <>
      <div className="header">
        <div>
          <h1>{snap.isHost ? 'Você está hospedando' : 'Na sala'}</h1>
          <StatusPills snap={snap} />
        </div>
        <button className="ghost" onClick={leave}>
          Sair
        </button>
      </div>

      {snap.code && (
        <div className="card">
          <label>Código para compartilhar</label>
          <div className="code-box">
            <span>{snap.code}</span>
            <button onClick={copy}>{copied ? 'Copiado' : 'Copiar'}</button>
          </div>
        </div>
      )}

      {media.watching > snap.maxRecommendedSubscriptions && (
        <div className="notice">
          Você está assistindo {media.watching} transmissões ao mesmo tempo. Acima
          de {snap.maxRecommendedSubscriptions} o consumo de CPU e banda sobe
          bastante — considere fechar alguma.
        </div>
      )}

      <CapturePanel media={media} />

      <StreamsPanel
        media={media}
        streams={snap.streams}
        roster={snap.roster}
        selfPeerId={snap.selfPeerId}
        onFloat={onFloat}
      />

      <div className="card">
        <h2>Participantes ({snap.roster.length})</h2>
        <ul className="roster">
          {[...snap.roster]
            .sort((a, b) => a.joinSeq - b.joinSeq)
            .map((e) => (
              <RosterRow
                key={e.peerId}
                e={e}
                self={e.peerId === snap.selfPeerId}
                publishing={snap.streams.some((s) => s.ownerPeerId === e.peerId)}
              />
            ))}
        </ul>
      </div>
    </>
  );
}

function RosterRow({
  e,
  self,
  publishing,
}: {
  e: RosterEntry;
  self: boolean;
  publishing: boolean;
}) {
  return (
    <li>
      <div className="avatar">{e.nickname.slice(0, 2).toUpperCase()}</div>
      <span className="name">
        {e.nickname}
        {self && <span className="muted"> (você)</span>}
      </span>
      {e.isHost && <span className="badge host">host</span>}
      {publishing && <span className="badge live">transmitindo</span>}
      {!e.isHost && (
        <span className="badge" title="alcançável de fora (candidato a host)">
          {e.inboundVerified ? '✓ alcançável' : '— sem porta'}
        </span>
      )}
    </li>
  );
}

function StatusPills({ snap }: { snap: SessionSnapshot }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <span className="pill">epoch {snap.epoch}</span>
    </div>
  );
}
