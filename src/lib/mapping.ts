import { z } from 'zod';

/**
 * Canonical field vocabulary for facility column mappings.
 *
 * A mapping is { canonical field -> source spreadsheet header }. phone and
 * membership_status have no destination column yet — they are captured verbatim
 * in import_rows.raw only; mapping them is allowed so the mapping documents the
 * export, but ingestion does not interpret them this slice.
 */
export const CANONICAL_FIELDS = [
  'external_ref',
  'first_name',
  'last_name',
  'email',
  'phone',
  'skill_level_raw',
  'membership_status',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export type ColumnMapping = Partial<Record<CanonicalField, string>>;

export const columnMappingSchema = z
  .record(z.enum(CANONICAL_FIELDS), z.string().min(1))
  .superRefine((mapping, ctx) => {
    const sources = Object.values(mapping);
    if (new Set(sources).size !== sources.length) {
      // SheetJS silently renames duplicate headers (Email, Email_1), so a mapping
      // pointing two fields at one header is always a mistake.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'each source header may be mapped only once',
      });
    }
    if (!('email' in mapping) && !('external_ref' in mapping)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mapping must include at least one of: email, external_ref',
      });
    }
  });

/** Order-sensitive comparison of a stored header signature against detected headers. */
export function diffHeaderSignature(
  expected: readonly string[],
  detected: readonly string[],
): { matches: boolean; missing: string[]; added: string[] } {
  const matches =
    expected.length === detected.length && expected.every((h, i) => h === detected[i]);
  return {
    matches,
    missing: expected.filter((h) => !detected.includes(h)),
    added: detected.filter((h) => !expected.includes(h)),
  };
}
