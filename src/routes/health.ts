import { Router } from 'express';
import { z } from 'zod';

import { sendValidated } from '../lib/http';
import { SERVICE_VERSION } from '../lib/version';

/** Contract for GET /health. Render's health check and the app both read this. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string().datetime(),
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  sendValidated(res, 200, healthResponseSchema, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: SERVICE_VERSION,
  });
});
