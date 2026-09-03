import type { SupabaseClient } from '@supabase/supabase-js';

import type { ColumnMapping } from './mapping';

export const SKIP_REASONS = [
  'no_identifiers',
  'duplicate_in_file',
  'unmappable_row',
  'email_conflict',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface RowResult {
  rowNumber: number; // 1 = first data row
  raw: Record<string, string | null>;
  outcome: 'matched' | 'created' | 'skipped';
  skipReason: SkipReason | null;
  playerId: string | null;
}

export interface ImportRunResult {
  counts: { matched: number; created: number; skipped: number };
  rowResults: RowResult[];
}

/** trim + lowercase; empty -> null. Matching is always on this form. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' ? null : v;
}

function normalizeRef(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

function normalizeName(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().replace(/\s+/g, ' ');
  return v === '' ? null : v;
}

interface CanonRow {
  externalRef: string | null;
  email: string | null;
  displayName: string | null;
  skillLevelRaw: string | null;
}

function canonicalize(raw: Record<string, string | null>, mapping: ColumnMapping): CanonRow {
  const pick = (field: keyof ColumnMapping): string | null => {
    const header = mapping[field];
    return header === undefined ? null : (raw[header] ?? null);
  };
  const first = normalizeName(pick('first_name'));
  const last = normalizeName(pick('last_name'));
  return {
    externalRef: normalizeRef(pick('external_ref')),
    email: normalizeEmail(pick('email')),
    displayName: [first, last].filter((p) => p !== null).join(' ') || null,
    skillLevelRaw: normalizeRef(pick('skill_level_raw')),
  };
}

/**
 * The idempotent upsert. Match order per the signed-off algorithm:
 *   a) facility_members by (facility_id, external_ref)      -> matched
 *   b) players by normalized email (conflict-checked)       -> matched
 *   c) any identifier present                               -> created (shadow player)
 *   d) otherwise                                            -> skipped
 * A second identical run matches everything the first created, changing nothing.
 *
 * Runs through the secret-key client as sequential per-row upserts, NOT one DB
 * transaction (PostgREST offers none). That is acceptable by design: every step
 * is idempotent on its natural key, so a failed run marked 'failed' is healed by
 * re-running, and the imports/import_rows audit records what happened either way.
 */
export async function runImportRows(
  db: SupabaseClient,
  facilityId: string,
  mapping: ColumnMapping,
  rows: Record<string, string | null>[],
): Promise<ImportRunResult> {
  const counts = { matched: 0, created: 0, skipped: 0 };
  const rowResults: RowResult[] = [];
  const seenEmails = new Set<string>();
  const seenRefs = new Set<string>();

  const fail = (step: string, error: { message: string } | null): never => {
    throw new Error(`${step}: ${error?.message ?? 'unknown error'}`);
  };

  for (const [index, raw] of rows.entries()) {
    const rowNumber = index + 1;
    const canon = canonicalize(raw, mapping);
    const record = (outcome: RowResult['outcome'], skipReason: SkipReason | null, playerId: string | null) => {
      counts[outcome] += 1;
      rowResults.push({ rowNumber, raw, outcome, skipReason, playerId });
    };

    // Skips first: unmappable, unmatchable, in-file duplicate (first occurrence wins).
    if (canon.externalRef === null && canon.email === null && canon.displayName === null) {
      record('skipped', 'unmappable_row', null);
      continue;
    }
    if (canon.externalRef === null && canon.email === null) {
      record('skipped', 'no_identifiers', null);
      continue;
    }
    if (
      (canon.email !== null && seenEmails.has(canon.email)) ||
      (canon.externalRef !== null && seenRefs.has(canon.externalRef))
    ) {
      record('skipped', 'duplicate_in_file', null);
      continue;
    }
    if (canon.email !== null) seenEmails.add(canon.email);
    if (canon.externalRef !== null) seenRefs.add(canon.externalRef);

    // (a) membership by external_ref.
    if (canon.externalRef !== null) {
      const { data: member, error } = await db
        .from('facility_members')
        .select('id, player_id')
        .eq('facility_id', facilityId)
        .eq('external_ref', canon.externalRef)
        .maybeSingle();
      if (error) fail('match external_ref', error);

      if (member) {
        if (canon.skillLevelRaw !== null) {
          const { error: updError } = await db
            .from('facility_members')
            .update({ skill_level_raw: canon.skillLevelRaw })
            .eq('id', member.id);
          if (updError) fail('refresh membership', updError);
        }
        // Backfill a missing player email if this export now provides one and
        // no other player owns it. Best-effort; never overwrites an email.
        if (canon.email !== null) {
          const { data: player } = await db
            .from('players')
            .select('id, email')
            .eq('id', member.player_id)
            .maybeSingle();
          if (player && player.email === null) {
            const { data: taken } = await db
              .from('players')
              .select('id')
              .eq('email', canon.email)
              .maybeSingle();
            if (!taken) {
              await db.from('players').update({ email: canon.email }).eq('id', player.id);
            }
          }
        }
        record('matched', null, member.player_id);
        continue;
      }
    }

    // (b) player by normalized email.
    if (canon.email !== null) {
      const { data: player, error } = await db
        .from('players')
        .select('id')
        .eq('email', canon.email)
        .maybeSingle();
      if (error) fail('match email', error);

      if (player) {
        const { data: existing, error: exError } = await db
          .from('facility_members')
          .select('id, external_ref')
          .eq('facility_id', facilityId)
          .eq('player_id', player.id)
          .maybeSingle();
        if (exError) fail('load membership', exError);

        // Ruling: the email's player carrying a DIFFERENT external_ref than the
        // row is a conflict for a human to resolve — skip, never auto-merge.
        if (
          existing &&
          canon.externalRef !== null &&
          existing.external_ref !== null &&
          existing.external_ref !== canon.externalRef
        ) {
          record('skipped', 'email_conflict', player.id);
          continue;
        }

        if (existing) {
          const patch: Record<string, string> = {};
          if (canon.skillLevelRaw !== null) patch['skill_level_raw'] = canon.skillLevelRaw;
          if (existing.external_ref === null && canon.externalRef !== null) {
            patch['external_ref'] = canon.externalRef;
          }
          if (Object.keys(patch).length > 0) {
            const { error: updError } = await db
              .from('facility_members')
              .update(patch)
              .eq('id', existing.id);
            if (updError) fail('refresh membership', updError);
          }
        } else {
          const { error: insError } = await db.from('facility_members').insert({
            facility_id: facilityId,
            player_id: player.id,
            external_ref: canon.externalRef,
            skill_level_raw: canon.skillLevelRaw,
            joined_via: 'import',
            status: 'active', // roster status: they appear on the club's roster
          });
          if (insError) fail('attach membership', insError);
        }
        record('matched', null, player.id);
        continue;
      }
    }

    // (c) create shadow player + membership.
    const { data: created, error: createError } = await db
      .from('players')
      .insert({
        email: canon.email,
        display_name: canon.displayName ?? canon.externalRef ?? '(unnamed import)',
        auth_user_id: null, // shadow until claimed at signup
      })
      .select('id')
      .single();
    if (createError || !created) fail('create player', createError);

    const { error: memberError } = await db.from('facility_members').insert({
      facility_id: facilityId,
      player_id: created!.id,
      external_ref: canon.externalRef,
      skill_level_raw: canon.skillLevelRaw,
      joined_via: 'import',
      status: 'active',
    });
    if (memberError) fail('create membership', memberError);

    record('created', null, created!.id);
  }

  return { counts, rowResults };
}
