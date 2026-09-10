import { useEffect, useRef, useState } from 'react';
import type { CaptureSource } from '../../shared/ipc.js';
import { type LocalCapture, startCapture, stopCapture } from './capture.js';

export function CapturePanel() {
  const [capture, setCapture] = useState<LocalCapture | null>(null);
  const [picking, setPicking] = useState(false);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // attach / detach the preview stream
  useEffect(() => {
    const el = videoRef.current;
    if (el && capture) {
      el.srcObject = capture.stream;
      void el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [capture]);

  // stop everything when the panel unmounts (e.g. leaving the room)
  useEffect(() => () => stopCapture(capture), [capture]);

  // react to the OS "stop sharing" affordance ending the track
  useEffect(() => {
    if (!capture) return;
    const track = capture.stream.getVideoTracks()[0];
    if (!track) return;
    const onEnded = () => {
      stopCapture(capture);
      setCapture(null);
    };
    track.addEventListener('ended', onEnded);
    return () => track.removeEventListener('ended', onEnded);
  }, [capture]);

  const openPicker = async () => {
    setError(null);
    setPicking(true);
    setSources(null);
    try {
      setSources(await window.erros.listSources());
    } catch (err) {
      setError((err as Error).message);
      setPicking(false);
    }
  };

  const pick = async (source: CaptureSource) => {
    setError(null);
    try {
      const next = await startCapture(source);
      setCapture(next);
      setPicking(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const stop = () => {
    stopCapture(capture);
    setCapture(null);
  };

  if (capture) {
    return (
      <div className="card">
        <div className="stage-head">
          <h2>Sua transmissão (prévia local)</h2>
          <button className="ghost" onClick={stop}>
            Parar
          </button>
        </div>
        <video
          ref={videoRef}
          className="preview"
          muted
          autoPlay
          playsInline
        />
        <p className="muted" style={{ marginBottom: 0 }}>
          {capture.source.name}
          {capture.hasAudio ? ' · com áudio do sistema' : ' · sem áudio'} — ainda
          não está sendo enviada para ninguém (chega no próximo checkpoint).
        </p>
      </div>
    );
  }

  if (picking) {
    return (
      <div className="card">
        <div className="stage-head">
          <h2>Escolha o que transmitir</h2>
          <button className="ghost" onClick={() => setPicking(false)}>
            Cancelar
          </button>
        </div>
        {sources === null ? (
          <p className="muted">
            <span className="spinner" />
            Buscando telas e janelas…
          </p>
        ) : sources.length === 0 ? (
          <p className="muted">Nenhuma fonte disponível.</p>
        ) : (
          <div className="source-grid">
            {sources.map((s) => (
              <button key={s.id} className="source" onClick={() => pick(s)}>
                <img src={s.thumbnail} alt="" />
                <span>
                  <span className="source-kind">
                    {s.kind === 'screen' ? 'Tela' : 'Janela'}
                  </span>
                  {s.name}
                </span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="stage-head">
        <h2>Transmissão</h2>
        <button className="primary" onClick={openPicker}>
          Transmitir minha tela
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Você pode transmitir uma tela inteira ou uma janela específica. O áudio
        capturado é o do sistema todo.
      </p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
