import { Router } from 'express';
import { z } from 'zod';

import { requireFacilityAdmin, type FacilityAdmin } from '../lib/auth';
import { runGenerationJob, type GenerationStats } from '../lib/generateSessions';
import { sendValidated } from '../lib/http';
import { supabase } from '../lib/supabase';

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const weekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .nonempty()
  .refine((w) => new Set(w).size === w.length, 'weekdays must be unique (ISO 1=Mon..7=Sun)');

const createSchema = z.object({
  name: z.string().min(1).max(100),
  sessionType: z.enum(['open_play', 'league', 'clinic', 'crew_session', 'social']).default('open_play'),
  skillBandLabel: z.string().min(1).max(50).nullish(),
  weekdays: weekdaysSchema,
  startTimeLocal: timeSchema,
  endTimeLocal: timeSchema, // <= start means the slot straddles midnight
  capacity: z.number().int().positive().nullish(),
  effectiveFrom: dateSchema.nullish(),
  effectiveUntil: dateSchema.nullish(),
});

const patchSchema = createSchema.partial().extend({ active: z.boolean().optional() });

const templateShape = z.object({
  id: z.string().uuid(),
  facilityId: z.string().uuid(),
  name: z.string(),
  sessionType: z.string(),
  skillBandLabel: z.string().nullable(),
  weekdays: z.array(z.number().int()),
  startTimeLocal: z.string(),
  endTimeLocal: z.string(),
  capacity: z.number().int().nullable(),
  active: z.boolean(),
  effectiveFrom: z.string().nullable(),
  effectiveUntil: z.string().nullable(),
});

export const generationStatsShape = z.object({
  jobRunId: z.string().uuid(),
  correlationId: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  stats: z.object({
    facilities: z.number().int(),
    templates: z.number().int(),
    created: z.number().int(),
    skipped: z.number().int(),
    cancelled: z.number().int(),
    resurrected: z.number().int(),
    degenerate: z.number().int(),
  }),
});

const templateResponse = z.object({ template: templateShape, generation: generationStatsShape });

const SELECT_COLS =
  'id, facility_id, name, session_type, skill_band_label, weekdays, start_time_local, end_time_local, capacity, active, effective_from, effective_until';

// PostgREST returns time columns as HH:MM:SS; trim for the API's HH:MM shape.
function toApi(row: Record<string, unknown>): z.infer<typeof templateShape> {
  return {
    id: row['id'] as string,
    facilityId: row['facility_id'] as string,
    name: row['name'] as string,
    sessionType: row['session_type'] as string,
    skillBandLabel: row['skill_band_label'] as string | null,
    weekdays: row['weekdays'] as number[],
    startTimeLocal: (row['start_time_local'] as string).slice(0, 5),
    endTimeLocal: (row['end_time_local'] as string).slice(0, 5),
    capacity: row['capacity'] as number | null,
    active: row['active'] as boolean,
    effectiveFrom: row['effective_from'] as string | null,
    effectiveUntil: row['effective_until'] as string | null,
  };
}

export const sessionTemplatesRouter = Router();

sessionTemplatesRouter.get(
  '/facilities/:id/session-templates',
  requireFacilityAdmin('id'),
  async (_req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;
      const { data, error } = await supabase()
        .from('session_templates')
        .select(SELECT_COLS)
        .eq('facility_id', admin.facilityId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      sendValidated(res, 200, z.object({ templates: z.array(templateShape) }), {
        templates: (data ?? []).map(toApi),
      });
    } catch (error) {
      next(error);
    }
  },
);

sessionTemplatesRouter.post(
  '/facilities/:id/session-templates',
  requireFacilityAdmin('id'),
  async (req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid_template', issues: parsed.error.issues });
        return;
      }
      const b = parsed.data;
      const { data, error } = await supabase()
        .from('session_templates')
        .insert({
          facility_id: admin.facilityId,
          name: b.name,
          session_type: b.sessionType,
          skill_band_label: b.skillBandLabel ?? null,
          weekdays: b.weekdays,
          start_time_local: b.startTimeLocal,
          end_time_local: b.endTimeLocal,
          capacity: b.capacity ?? null,
          effective_from: b.effectiveFrom ?? null,
          effective_until: b.effectiveUntil ?? null,
          created_by: admin.playerId,
        })
        .select(SELECT_COLS)
        .single();
      if (error || !data) throw error ?? new Error('insert returned no row');

      // Inline generation: the organizer sees the schedule change immediately.
      const generation = await runGenerationJob(supabase(), admin.facilityId);
      sendValidated(res, 201, templateResponse, { template: toApi(data), generation });
    } catch (error) {
      next(error);
    }
  },
);

sessionTemplatesRouter.patch(
  '/facilities/:id/session-templates/:templateId',
  requireFacilityAdmin('id'),
  async (req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;
      const templateId = z.string().uuid().safeParse(req.params['templateId']);
      if (!templateId.success) {
        res.status(400).json({ error: 'invalid_template_id' });
        return;
      }
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        res.status(422).json({ error: 'invalid_template_patch', issues: parsed.success ? [] : parsed.error.issues });
        return;
      }
      const b = parsed.data;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (b.name !== undefined) patch['name'] = b.name;
      if (b.sessionType !== undefined) patch['session_type'] = b.sessionType;
      if (b.skillBandLabel !== undefined) patch['skill_band_label'] = b.skillBandLabel;
      if (b.weekdays !== undefined) patch['weekdays'] = b.weekdays;
      if (b.startTimeLocal !== undefined) patch['start_time_local'] = b.startTimeLocal;
      if (b.endTimeLocal !== undefined) patch['end_time_local'] = b.endTimeLocal;
      if (b.capacity !== undefined) patch['capacity'] = b.capacity;
      if (b.effectiveFrom !== undefined) patch['effective_from'] = b.effectiveFrom;
      if (b.effectiveUntil !== undefined) patch['effective_until'] = b.effectiveUntil;
      if (b.active !== undefined) patch['active'] = b.active;

      const { data, error } = await supabase()
        .from('session_templates')
        .update(patch)
        .eq('id', templateId.data)
        .eq('facility_id', admin.facilityId) // template must belong to this facility
        .select(SELECT_COLS)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }

      const generation = await runGenerationJob(supabase(), admin.facilityId);
      sendValidated(res, 200, templateResponse, { template: toApi(data), generation });
    } catch (error) {
      next(error);
    }
  },
);

/** Deactivate = soft. Future sessions are cancelled by the inline reconcile. */
sessionTemplatesRouter.delete(
  '/facilities/:id/session-templates/:templateId',
  requireFacilityAdmin('id'),
  async (req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;
      const templateId = z.string().uuid().safeParse(req.params['templateId']);
      if (!templateId.success) {
        res.status(400).json({ error: 'invalid_template_id' });
        return;
      }
      const { data, error } = await supabase()
        .from('session_templates')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', templateId.data)
        .eq('facility_id', admin.facilityId)
        .select(SELECT_COLS)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: 'template_not_found' });
        return;
      }
      const generation = await runGenerationJob(supabase(), admin.facilityId);
      sendValidated(res, 200, templateResponse, { template: toApi(data), generation });
    } catch (error) {
      next(error);
    }
  },
);

/** Manual per-facility run for dev/testing and organizer "regenerate now". */
sessionTemplatesRouter.post(
  '/facilities/:id/generate-sessions',
  requireFacilityAdmin('id'),
  async (_req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;
      const generation = await runGenerationJob(supabase(), admin.facilityId);
      sendValidated(res, 200, generationStatsShape, generation);
    } catch (error) {
      next(error);
    }
  },
);

export type { GenerationStats };
