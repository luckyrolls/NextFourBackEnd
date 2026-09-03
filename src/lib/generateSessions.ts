import type { SupabaseClient } from '@supabase/supabase-js';

import { addDays, expandRule, localToday } from './schedule';

export interface GenerationStats {
  facilities: number;
  templates: number;
  created: number;
  skipped: number;
  cancelled: number;
  resurrected: number;
  degenerate: number;
}

const emptyStats = (): GenerationStats => ({
  facilities: 0,
  templates: 0,
  created: 0,
  skipped: 0,
  cancelled: 0,
  resurrected: 0,
  degenerate: 0,
});

interface TemplateRow {
  id: string;
  facility_id: string;
  session_type: string;
  skill_band_label: string | null;
  weekdays: number[];
  start_time_local: string;
  end_time_local: string;
  capacity: number | null;
  active: boolean;
  effective_from: string | null;
  effective_until: string | null;
}

/**
 * Generates and reconciles template-sourced sessions for ONE facility.
 *
 * Creation window: the 14 full facility-local days starting TOMORROW — full
 * days keep runs deterministic regardless of run time; a session on date D
 * first exists 14 days ahead, so in steady state today's sessions were created
 * long ago. (Known limit: a template created today spawns nothing for today.)
 *
 * Reconciliation window: every future session (starts_at >= now), tonight's
 * included — validity is judged against expansion from TODAY so tonight's
 * sessions aren't falsely orphaned. Sessions in the past are never touched.
 * Orphans are CANCELLED, never deleted; re-validated cancelled sessions are
 * resurrected to scheduled.
 *
 * Idempotent via unique (template_id, starts_at) + ignoreDuplicates upsert:
 * a second identical run creates zero rows.
 */
export async function generateForFacility(
  db: SupabaseClient,
  facility: { id: string; timezone: string },
  horizonDays = 14,
): Promise<GenerationStats> {
  const stats = emptyStats();
  stats.facilities = 1;
  const nowIso = new Date().toISOString();
  const today = localToday(facility.timezone);
  const tomorrow = addDays(today, 1);

  const { data: templates, error: tplError } = await db
    .from('session_templates')
    .select(
      'id, facility_id, session_type, skill_band_label, weekdays, start_time_local, end_time_local, capacity, active, effective_from, effective_until',
    )
    .eq('facility_id', facility.id)
    .eq('active', true);
  if (tplError) throw new Error(`load templates: ${tplError.message}`);
  const activeTemplates = (templates ?? []) as TemplateRow[];
  stats.templates = activeTemplates.length;

  // Expected occurrences per template: from TODAY over horizon+1 days, so the
  // reconcile step can vouch for tonight's sessions; creation uses only those
  // from tomorrow onward.
  const expectedKeys = new Set<string>(); // `${templateId}|${startsAt}`
  const toInsert: Record<string, unknown>[] = [];

  for (const tpl of activeTemplates) {
    const rule = {
      weekdays: tpl.weekdays,
      startTimeLocal: tpl.start_time_local,
      endTimeLocal: tpl.end_time_local,
      effectiveFrom: tpl.effective_from,
      effectiveUntil: tpl.effective_until,
    };
    const { occurrences, degenerate } = expandRule(rule, facility.timezone, today, horizonDays + 1);
    stats.degenerate += degenerate;

    for (const occ of occurrences) {
      expectedKeys.add(`${tpl.id}|${occ.startsAt}`);
      if (occ.localDate >= tomorrow && occ.localDate < addDays(tomorrow, horizonDays)) {
        toInsert.push({
          facility_id: facility.id,
          template_id: tpl.id,
          source: 'recurring_template',
          session_type: tpl.session_type,
          skill_band_label: tpl.skill_band_label,
          capacity: tpl.capacity,
          starts_at: occ.startsAt,
          ends_at: occ.endsAt,
          status: 'scheduled',
        });
      }
    }
  }

  // Upsert new occurrences; conflicts on (template_id, starts_at) are skips.
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const { data: inserted, error } = await db
      .from('sessions')
      .upsert(chunk, { onConflict: 'template_id,starts_at', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error(`insert sessions: ${error.message}`);
    stats.created += inserted?.length ?? 0;
  }
  stats.skipped = toInsert.length - stats.created;

  // Reconcile: every future template-sourced session must still be expected.
  const { data: futureRows, error: futError } = await db
    .from('sessions')
    .select('id, template_id, starts_at, status')
    .eq('facility_id', facility.id)
    .eq('source', 'recurring_template')
    .gte('starts_at', nowIso);
  if (futError) throw new Error(`load future sessions: ${futError.message}`);

  const toCancel: string[] = [];
  const toResurrect: string[] = [];
  for (const row of futureRows ?? []) {
    // PostgREST renders timestamptz with an offset; normalize to the instant.
    const key = `${row.template_id}|${new Date(row.starts_at).toISOString().replace('.000Z', 'Z')}`;
    const expected = row.template_id !== null && expectedKeys.has(key);
    if (!expected && row.status === 'scheduled') toCancel.push(row.id);
    if (expected && row.status === 'cancelled') toResurrect.push(row.id);
  }
  if (toCancel.length > 0) {
    const { error } = await db.from('sessions').update({ status: 'cancelled' }).in('id', toCancel);
    if (error) throw new Error(`cancel sessions: ${error.message}`);
  }
  if (toResurrect.length > 0) {
    const { error } = await db.from('sessions').update({ status: 'scheduled' }).in('id', toResurrect);
    if (error) throw new Error(`resurrect sessions: ${error.message}`);
  }
  stats.cancelled = toCancel.length;
  stats.resurrected = toResurrect.length;

  return stats;
}

/** Runs generation for every facility (or one), wrapped in a job_runs audit row. */
export async function runGenerationJob(
  db: SupabaseClient,
  onlyFacilityId?: string,
): Promise<{ jobRunId: string; correlationId: string; status: 'succeeded' | 'failed'; stats: GenerationStats }> {
  const { data: jobRow, error: jobError } = await db
    .from('job_runs')
    .insert({ job_name: 'generate_sessions', status: 'running' })
    .select('id, correlation_id')
    .single();
  if (jobError || !jobRow) throw new Error(`job_runs insert: ${jobError?.message ?? 'no row'}`);

  const total = emptyStats();
  try {
    let query = db.from('facilities').select('id, timezone');
    if (onlyFacilityId !== undefined) query = query.eq('id', onlyFacilityId);
    const { data: facilities, error: facError } = await query;
    if (facError) throw new Error(`load facilities: ${facError.message}`);

    for (const facility of facilities ?? []) {
      const stats = await generateForFacility(db, facility);
      for (const k of Object.keys(total) as (keyof GenerationStats)[]) total[k] += stats[k];
    }

    await db
      .from('job_runs')
      .update({ status: 'succeeded', finished_at: new Date().toISOString(), stats: total })
      .eq('id', jobRow.id);
    return { jobRunId: jobRow.id, correlationId: jobRow.correlation_id, status: 'succeeded', stats: total };
  } catch (error) {
    await db
      .from('job_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        stats: { ...total, error: error instanceof Error ? error.message : String(error) },
      })
      .eq('id', jobRow.id);
    throw error;
  }
}
