import type { Response } from 'express';
import type { z } from 'zod';

/**
 * Boundary validation for outbound payloads.
 *
 * Every response body is parsed against its declared schema before it leaves the
 * process. Inbound validation (`schema.parse(req.body)`) is the mirror of this and
 * is added per-endpoint as endpoints with bodies arrive. A response that fails its
 * own contract is a server bug, so it surfaces as a 500 rather than shipping a
 * malformed body to the app.
 */
export function sendValidated<TSchema extends z.ZodTypeAny>(
  res: Response,
  status: number,
  schema: TSchema,
  payload: unknown,
): void {
  const result = schema.safeParse(payload);

  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('Response failed its own schema:', result.error.flatten());
    res.status(500).json({ error: 'internal_error' });
    return;
  }

  res.status(status).json(result.data);
}
