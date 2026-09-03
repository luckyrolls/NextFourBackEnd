import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../lib/env';
import { runGenerationJob } from '../lib/generateSessions';
import { sendValidated } from '../lib/http';
import { supabase } from '../lib/supabase';
import { generationStatsShape } from './sessionTemplates';

/**
 * Internal job endpoints — machine auth via JOB_RUN_TOKEN (X-Job-Token header),
 * not facility-admin JWTs. The GitHub Actions scheduled workflow is the caller.
 *
 * Cadence (hard rule 7, plain English): generate-sessions runs once per day at
 * 09:07 UTC — early morning US-Eastern — plus inline on every template CRUD and
 * on demand here. It does not run hourly, and never every minute.
 */
export const jobsRouter = Router();

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

jobsRouter.post('/internal/jobs/generate-sessions', async (req, res, next) => {
  try {
    const expected = env().JOB_RUN_TOKEN;
    if (!expected) {
      // Deliberately a 503, not a crash at boot: an unset token disables the
      // job endpoint without taking the whole service down.
      res.status(503).json({ error: 'job_endpoint_disabled', detail: 'JOB_RUN_TOKEN is not configured' });
      return;
    }
    const provided = req.header('x-job-token') ?? '';
    if (!tokenMatches(provided, expected)) {
      res.status(401).json({ error: 'invalid_job_token' });
      return;
    }

    const generation = await runGenerationJob(supabase());
    sendValidated(res, 200, generationStatsShape, generation);
  } catch (error) {
    next(error);
  }
});
