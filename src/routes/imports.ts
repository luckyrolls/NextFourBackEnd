import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { requireFacilityAdmin, type FacilityAdmin } from '../lib/auth';
import { sendValidated } from '../lib/http';
import { runImportRows, SKIP_REASONS } from '../lib/ingest';
import { diffHeaderSignature, type ColumnMapping } from '../lib/mapping';
import { parseMembersWorkbook, WorkbookFormatError } from '../lib/parseXlsx';
import { supabase } from '../lib/supabase';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const bodySchema = z.object({
  mappingVersion: z.coerce.number().int().positive().optional(), // default: latest
  sourceLabel: z.string().min(1).max(200).optional(), // default: uploaded filename
});

export const importResponseSchema = z.object({
  importId: z.string().uuid(),
  correlationId: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  mappingVersion: z.number().int().positive(),
  counts: z.object({
    matched: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  skips: z.array(
    z.object({ rowNumber: z.number().int().positive(), reason: z.enum(SKIP_REASONS) }),
  ),
});

export const importsRouter = Router();

/**
 * POST /facilities/:id/imports — multipart upload of a members-report xlsx
 * (field name "file"). Runs the idempotent upsert and answers with the audit
 * counts. 409s: no mapping yet (body carries detected headers to build one
 * from), or header signature drift (body carries the diff).
 */
importsRouter.post(
  '/facilities/:id/imports',
  requireFacilityAdmin('id'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const admin = res.locals['admin'] as FacilityAdmin;

      if (!req.file) {
        res.status(422).json({ error: 'missing_file_field' });
        return;
      }
      const body = bodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(422).json({ error: 'invalid_body', issues: body.error.issues });
        return;
      }

      let parsed;
      try {
        parsed = parseMembersWorkbook(req.file.buffer);
      } catch (error) {
        if (error instanceof WorkbookFormatError) {
          res.status(422).json({ error: 'unparseable_workbook', detail: error.message });
          return;
        }
        res.status(422).json({ error: 'unparseable_workbook', detail: 'not a readable xlsx file' });
        return;
      }

      // Resolve the mapping: requested version, else latest. None -> 409 with
      // the detected headers, ready to paste into POST .../column-mappings.
      let query = supabase()
        .from('facility_column_mappings')
        .select('id, version, mapping, header_signature')
        .eq('facility_id', admin.facilityId)
        .order('version', { ascending: false })
        .limit(1);
      if (body.data.mappingVersion !== undefined) {
        query = supabase()
          .from('facility_column_mappings')
          .select('id, version, mapping, header_signature')
          .eq('facility_id', admin.facilityId)
          .eq('version', body.data.mappingVersion)
          .limit(1);
      }
      const { data: mappings, error: mappingError } = await query;
      if (mappingError) throw mappingError;
      const mappingRow = mappings?.[0];
      if (!mappingRow) {
        res.status(409).json({ error: 'no_column_mapping', detectedHeaders: parsed.headers });
        return;
      }

      const diff = diffHeaderSignature(mappingRow.header_signature, parsed.headers);
      if (!diff.matches) {
        res.status(409).json({
          error: 'header_signature_mismatch',
          mappingVersion: mappingRow.version,
          expected: mappingRow.header_signature,
          detected: parsed.headers,
          missing: diff.missing,
          added: diff.added,
        });
        return;
      }

      // Audit row first: a crashed run still leaves a 'running'/'failed' record.
      const { data: importRow, error: importError } = await supabase()
        .from('imports')
        .insert({
          facility_id: admin.facilityId,
          adapter: 'report_upload',
          source_label: body.data.sourceLabel ?? req.file.originalname,
          column_mapping_id: mappingRow.id,
          status: 'running',
        })
        .select('id, correlation_id')
        .single();
      if (importError || !importRow) throw importError ?? new Error('imports insert returned no row');

      let run;
      try {
        run = await runImportRows(
          supabase(),
          admin.facilityId,
          mappingRow.mapping as ColumnMapping,
          parsed.rows,
        );
      } catch (error) {
        await supabase()
          .from('imports')
          .update({ status: 'failed', finished_at: new Date().toISOString() })
          .eq('id', importRow.id);
        next(error);
        return;
      }

      // Persist per-row audit in chunks (payload size, not transactionality).
      for (let i = 0; i < run.rowResults.length; i += 200) {
        const chunk = run.rowResults.slice(i, i + 200).map((r) => ({
          import_id: importRow.id,
          row_number: r.rowNumber,
          raw: r.raw,
          outcome: r.outcome,
          skip_reason: r.skipReason,
          player_id: r.playerId,
        }));
        const { error: rowsError } = await supabase().from('import_rows').insert(chunk);
        if (rowsError) throw rowsError;
      }

      const { error: finishError } = await supabase()
        .from('imports')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          rows_matched: run.counts.matched,
          rows_created: run.counts.created,
          rows_skipped: run.counts.skipped,
        })
        .eq('id', importRow.id);
      if (finishError) throw finishError;

      sendValidated(res, 201, importResponseSchema, {
        importId: importRow.id,
        correlationId: importRow.correlation_id,
        status: 'succeeded',
        mappingVersion: mappingRow.version,
        counts: run.counts,
        skips: run.rowResults
          .filter((r) => r.outcome === 'skipped')
          .map((r) => ({ rowNumber: r.rowNumber, reason: r.skipReason })),
      });
    } catch (error) {
      next(error);
    }
  },
);
