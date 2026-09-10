/**
 * IPC contract between the Electron main process and the renderer.
 * The renderer never touches the network or Node APIs directly - it only
 * calls these channels through the `window.erros` bridge (see src/preload).
 */

import type { Body, RosterEntry, StreamInfo } from './protocol.js';

export type { StreamInfo, RosterEntry } from './protocol.js';

export type SessionPhase =
  | 'idle'
  | 'discovering'
  | 'connecting'
  | 'in-room'
  | 'hosting'
  | 'reconnecting'
  | 'promoting'
  | 'left';

export interface RoomCodeStatus {
  readonly mappingMethod: 'nat-pmp' | 'upnp' | 'manual';
  readonly externalAddress: string;
  readonly directlyReachable: boolean;
  /** non-null => the user cannot host as-is */
  readonly blocker: 'carrier_grade_nat' | 'no_inbound_path' | null;
  /** internal port to forward if `blocker === 'no_inbound_path'` */
  readonly manualForwardPort: number | null;
  readonly manualForwardTo: string | null;
}

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly isHost: boolean;
  readonly selfPeerId: string;
  readonly nickname: string;
  readonly epoch: number;
  readonly code: string | null;
  readonly codeStatus: RoomCodeStatus | null;
  readonly roster: RosterEntry[];
  readonly streams: StreamInfo[];
  /** soft cap on simultaneous subscriptions before the UI warns */
  readonly maxRecommendedSubscriptions: number;
  readonly notice: string | null;
}

export interface HostRoomRequest {
  readonly nickname: string;
  readonly password: string;
  /** inbound TCP/UDP port; default 47821 */
  readonly port?: number;
}

export interface JoinRoomRequest {
  readonly nickname: string;
  readonly password: string;
  readonly code: string;
  /** this peer's own inbound port for failover candidacy; default 47822 */
  readonly inboundPort?: number;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** A screen or window the user can capture (from Electron's desktopCapturer). */
export interface CaptureSource {
  readonly id: string;
  readonly name: string;
  readonly kind: 'screen' | 'window';
  /** PNG data URL thumbnail */
  readonly thumbnail: string;
}

export const IPC = {
  hostRoom: 'session:host',
  joinRoom: 'session:join',
  leaveRoom: 'session:leave',
  getSnapshot: 'session:snapshot',
  listSources: 'capture:list-sources',
  setSource: 'capture:set-source',
  sendMedia: 'media:send',
  // main -> renderer
  onUpdate: 'session:update',
  onMedia: 'media:event',
  onError: 'session:error',
} as const;

/** The surface exposed on `window.erros` by the preload bridge. */
export interface ErrosApi {
  hostRoom(req: HostRoomRequest): Promise<IpcResult<SessionSnapshot>>;
  joinRoom(req: JoinRoomRequest): Promise<IpcResult<SessionSnapshot>>;
  leaveRoom(): Promise<IpcResult<SessionSnapshot>>;
  getSnapshot(): Promise<SessionSnapshot>;
  onUpdate(cb: (snapshot: SessionSnapshot) => void): () => void;
  /** enumerate capturable screens and windows */
  listSources(): Promise<CaptureSource[]>;
  /** tell the main process which source the next getDisplayMedia() should use */
  setCaptureSource(id: string): Promise<IpcResult<null>>;
  /** send a media negotiation body (publish_offer, subscribe, subscribe_answer, ...) */
  sendMedia(body: MediaBody): void;
  /** media bodies coming back (publish_answer, subscribe_offer, stream_state, media_error) */
  onMedia(cb: (body: MediaBody) => void): () => void;
}

/** The media subset of the protocol `Body` union, used across the IPC bridge. */
export type MediaBody = Extract<
  Body,
  {
    type:
      | 'publish_offer'
      | 'publish_answer'
      | 'unpublish'
      | 'subscribe'
      | 'subscribe_offer'
      | 'subscribe_answer'
      | 'unsubscribe'
      | 'stream_state'
      | 'media_error'
      | 'quality_directive';
  }
>;
