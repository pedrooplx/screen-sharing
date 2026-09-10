import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const { installMock } = await import('./mock.js');
    installMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
