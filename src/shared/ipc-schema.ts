/** Runtime validation for IPC requests coming from the renderer. */

import { z } from 'zod';
import {
  mediaErrorSchema,
  publishAnswerSchema,
  publishOfferSchema,
  qualityDirectiveSchema,
  statsReportSchema,
  streamStateSchema,
  subscribeAnswerSchema,
  subscribeOfferSchema,
  subscribeSchema,
  unpublishSchema,
  unsubscribeSchema,
} from './protocol.js';

export const hostRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(256),
});

export const joinRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(256),
  code: z.string().min(8).max(256),
});

/** Media bodies the renderer may send inbound (and echo of what it receives). */
export const mediaBodySchema = z.discriminatedUnion('type', [
  publishOfferSchema,
  publishAnswerSchema,
  unpublishSchema,
  subscribeSchema,
  subscribeOfferSchema,
  subscribeAnswerSchema,
  unsubscribeSchema,
  streamStateSchema,
  mediaErrorSchema,
  qualityDirectiveSchema,
  statsReportSchema,
]);
