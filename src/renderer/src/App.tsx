import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshot } from '../../shared/ipc.js';
import type { RosterEntry } from '../../shared/protocol.js';
import { CapturePanel } from './CapturePanel.js';
import { StreamsPanel } from './StreamsPanel.js';
import { useMedia } from './rtc.js';

const IDLE: SessionSnapshot = {
  phase: 'idle',
  isHost: false,
  selfPeerId: '',
  nickname: '',
  epoch: 0,
  code: null,
  codeStatus: null,
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

  const inRoom =
    snap.phase === 'in-room' ||
    snap.phase === 'hosting' ||
    snap.phase === 'reconnecting' ||
    snap.phase === 'promoting';

  return (
    <div className="app">
      <div className="brand">
        <b>erros-share</b> — compartilhamento de tela P2P
      </div>
      {snap.notice && <div className="notice">{snap.notice}</div>}
      {inRoom ? (
        <Room snap={snap} />
      ) : (
        <Lobby phase={snap.phase} />
      )}
    </div>
  );
}

function Lobby({ phase }: { phase: SessionSnapshot['phase'] }) {
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'host' | 'join'>(null);
  const [error, setError] = useState<string | null>(null);

  const working = busy !== null || phase === 'discovering' || phase === 'connecting';

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
          {busy === 'host' || phase === 'discovering' ? (
            <>
              <span className="spinner" />
              Descobrindo rede…
            </>
          ) : (
            'Criar sala'
          )}
        </button>
      </div>

      <div className="card">
        <h2>Entrar numa sala</h2>
        <div className="field">
          <label htmlFor="code">Código da sala</label>
          <input
            id="code"
            value={code}
            placeholder="K7QM-4X2A-9BTR-…"
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
          {busy === 'join' || phase === 'connecting' ? (
            <>
              <span className="spinner" />
              Conectando…
            </>
          ) : (
            'Entrar'
          )}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
    </>
  );
}

function Room({ snap }: { snap: SessionSnapshot }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const media = useMedia(snap.streams, snap.epoch);

  const copy = useCallback(() => {
    if (!snap.code) return;
    void navigator.clipboard.writeText(snap.code);
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
          {snap.codeStatus?.blocker === 'no_inbound_path' && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Encaminhe <b>TCP {snap.codeStatus.manualForwardPort}</b> no seu
              roteador para o IP local deste PC — senão ninguém consegue entrar.
            </p>
          )}
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
      {snap.codeStatus && (
        <span
          className={`pill ${snap.codeStatus.blocker ? 'warn' : 'ok'}`}
          title={snap.codeStatus.externalAddress}
        >
          {snap.codeStatus.blocker === 'carrier_grade_nat'
            ? 'CGNAT — não pode hospedar'
            : snap.codeStatus.blocker === 'no_inbound_path'
              ? 'porta manual necessária'
              : `porta aberta via ${snap.codeStatus.mappingMethod}`}
        </span>
      )}
      {snap.phase === 'reconnecting' && (
        <span className="pill warn">
          <span className="spinner" />
          reconectando
        </span>
      )}
    </div>
  );
}
