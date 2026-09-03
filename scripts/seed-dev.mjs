/**
 * Dev seed — one SYNTHETIC facility and a handful of SYNTHETIC players.
 *
 * Idempotent: every row uses a fixed UUID and inserts with ON CONFLICT DO NOTHING,
 * so re-running creates zero duplicates. No real club names, no real people.
 *
 * Dev only. Run: npm run seed:dev  (requires SUPABASE_DB_URL in .env)
 */
import 'dotenv/config';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') {
  console.error('[seed] Refusing to run with NODE_ENV=production.');
  process.exit(1);
}

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('[seed] SUPABASE_DB_URL is not set (see .env.example).');
  process.exit(1);
}

// Fixed IDs — the d5eed... prefix marks every row this script owns.
const FACILITY_ID = 'd5eed000-0000-4000-a000-000000000001';

const PLAYERS = [
  // [id, email (normalized), display_name, external_ref, skill_level_raw]
  ['d5eed000-0000-4000-a000-000000000101', 'dev.alice@example.com',  'Dev Alice',  'EXT-1001', '3.5'],
  ['d5eed000-0000-4000-a000-000000000102', 'dev.bola@example.com',   'Dev Bola',   'EXT-1002', '4.0'],
  ['d5eed000-0000-4000-a000-000000000103', 'dev.chen@example.com',   'Dev Chen',   'EXT-1003', '3.0'],
  ['d5eed000-0000-4000-a000-000000000104', 'dev.dina@example.com',   'Dev Dina',   null,       '3.5'],
  // Shadow with no email at all — the external_ref-only import case.
  ['d5eed000-0000-4000-a000-000000000105', null,                     'Dev Emeka',  'EXT-1005', null],
];

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query('begin');

  const fac = await client.query(
    `insert into public.facilities (id, name, timezone, external_system, portal_url)
     values ($1, 'Synthetic Test Facility (dev seed — not a real club)', 'America/New_York', 'none', null)
     on conflict (id) do nothing`,
    [FACILITY_ID],
  );

  let playersCreated = 0;
  let membersCreated = 0;
  for (const [i, [id, email, displayName, externalRef, skillRaw]] of PLAYERS.entries()) {
    // All seeded players are shadow records: auth_user_id stays null.
    const p = await client.query(
      `insert into public.players (id, email, display_name, auth_user_id)
       values ($1, $2, $3, null)
       on conflict (id) do nothing`,
      [id, email, displayName],
    );
    playersCreated += p.rowCount;

    const memberId = `d5eed000-0000-4000-a000-0000000002${String(i + 1).padStart(2, '0')}`;
    const m = await client.query(
      `insert into public.facility_members
         (id, facility_id, player_id, role, status, external_ref, skill_level_raw, joined_via)
       values ($1, $2, $3, 'member', 'active', $4, $5, 'import')
       on conflict (id) do nothing`,
      [memberId, FACILITY_ID, id, externalRef, skillRaw],
    );
    membersCreated += m.rowCount;
  }

  await client.query('commit');
  console.log(
    `[seed] facility created: ${fac.rowCount}, players created: ${playersCreated}, ` +
      `memberships created: ${membersCreated} (0s across the board = already seeded, which is fine)`,
  );
} catch (error) {
  await client.query('rollback').catch(() => {});
  console.error(`[seed] FAILED and rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
