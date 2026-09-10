import type { ErrosApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    erros: ErrosApi;
  }
}

export {};
