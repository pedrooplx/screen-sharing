/** Runtime validation for IPC requests coming from the renderer. */

import { z } from 'zod';

export const hostRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(256),
  port: z.number().int().min(1024).max(65535).optional(),
});

export const joinRoomRequestSchema = z.object({
  nickname: z.string().trim().min(1).max(48),
  password: z.string().min(1).max(256),
  code: z.string().min(8).max(256),
  inboundPort: z.number().int().min(1024).max(65535).optional(),
});
