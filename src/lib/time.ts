/**
 * finished_at for audit rows whose started_at was stamped by the DATABASE clock.
 *
 * The local clock can trail the DB's by more than a fast run's duration, and
 * both imports and job_runs carry a finished_at >= started_at check — a skewed
 * local timestamp then fails the whole finalize. Clamp to the row's own
 * started_at so the pair is always consistent, and honest whenever clocks agree.
 */
export function finishedAtAfter(startedAtIso: string): string {
  // +1ms: Postgres keeps microseconds, JS Date truncates to milliseconds, so a
  // bare clamp can still land a fraction of a millisecond BEFORE started_at.
  return new Date(Math.max(Date.now(), new Date(startedAtIso).getTime() + 1)).toISOString();
}
