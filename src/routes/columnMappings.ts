import { Router } from 'express';
import { z } from 'zod';

import { requireFacilityAdmin, type FacilityAdmin } from '../lib/auth';
import { sendValidated } from '../lib/http';
import { columnMappingSchema } from '../lib/mapping';
import { supabase } from '../lib/supabase';

const requestSchema = z.object({
  mapping: columnMappingSchema,
  headerSignature: z.array(z.string()).nonempty(),
  note: z.string().max(500).optional(),
});

export const mappingResponseSchema = z.object({
  id: z.string().uuid(),
  facilityId: z.string().uuid(),
  version: z.number().int().positive(),
  mapping: z.record(z.string(), z.string()),
  headerSignature: z.array(z.string()),
});

export const columnMappingsRouter = Router();

/**
 * POST /facilities/:id/column-mappings — creates the NEXT mapping version.
 * Mappings are append-only: fixing one means posting a new version; imports
 * keep their FK to whichever version produced them.
 */
columnMappingsRouter.post(
  '/facilities/:id/column-mappings',
  requireFacilityAdmin('id'),
  async (req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;

      const parsed = requestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid_mapping', issues: parsed.error.issues });
        return;
      }
      const { mapping, headerSignature, note } = parsed.data;

      // Every mapped source header must exist in the signature it claims to map.
      const unknown = Object.values(mapping).filter((h) => !headerSignature.includes(h));
      if (unknown.length > 0) {
        res.status(422).json({ error: 'mapped_headers_not_in_signature', headers: unknown });
        return;
      }

      const { data: latest, error: latestError } = await supabase()
        .from('facility_column_mappings')
        .select('version')
        .eq('facility_id', admin.facilityId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestError) throw latestError;

      const { data: created, error: insertError } = await supabase()
        .from('facility_column_mappings')
        .insert({
          facility_id: admin.facilityId,
          version: (latest?.version ?? 0) + 1,
          mapping,
          header_signature: headerSignature,
          note: note ?? null,
        })
        .select('id, facility_id, version, mapping, header_signature')
        .single();
      if (insertError || !created) throw insertError ?? new Error('insert returned no row');

      sendValidated(res, 201, mappingResponseSchema, {
        id: created.id,
        facilityId: created.facility_id,
        version: created.version,
        mapping: created.mapping,
        headerSignature: created.header_signature,
      });
    } catch (error) {
      next(error);
    }
  },
);
