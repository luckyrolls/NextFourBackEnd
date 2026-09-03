/**
 * Dev seed — one SYNTHETIC facility and a handful of SYNTHETIC players.
 *
 * Idempotent: every row uses a fixed UUID and inserts with ON CONFLICT DO NOTHING,
 * so re-running creates zero duplicates. No real club names, no real people.
 *
 * Dev only. Run: npm run seed:dev  (requires SUPABASE_DB_URL in .env)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
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

// Dev organizer: a REAL auth user (organizer role) so the admin endpoints and
// npm run import:dev can authenticate the way production will.
const { SUPABASE_URL, SUPABASE_SECRET_KEY, DEV_ORGANIZER_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !DEV_ORGANIZER_PASSWORD) {
  console.error(
    '[seed] SUPABASE_URL, SUPABASE_SECRET_KEY and DEV_ORGANIZER_PASSWORD are required ' +
      '(see .env.example). DEV_ORGANIZER_PASSWORD is a local dev credential you choose.',
  );
  process.exit(1);
}
const ORGANIZER_EMAIL = 'dev.organizer@example.com';
const ORGANIZER_PLAYER_ID = 'd5eed000-0000-4000-a000-000000000110';
const ORGANIZER_MEMBER_ID = 'd5eed000-0000-4000-a000-000000000210';

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

  // Organizer auth user (idempotent: reuse if it already exists, sync password).
  const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 });
  let authUser = (userList?.users ?? []).find((u) => u.email === ORGANIZER_EMAIL);
  if (authUser) {
    await admin.auth.admin.updateUserById(authUser.id, { password: DEV_ORGANIZER_PASSWORD });
  } else {
    const createdUser = await admin.auth.admin.createUser({
      email: ORGANIZER_EMAIL,
      password: DEV_ORGANIZER_PASSWORD,
      email_confirm: true,
    });
    if (createdUser.error) throw new Error(`organizer auth user: ${createdUser.error.message}`);
    authUser = createdUser.data.user;
  }

  await client.query(
    `insert into public.players (id, email, display_name, auth_user_id)
     values ($1, $2, 'Dev Organizer', $3)
     on conflict (id) do update set auth_user_id = excluded.auth_user_id`,
    [ORGANIZER_PLAYER_ID, ORGANIZER_EMAIL, authUser.id],
  );
  await client.query(
    `insert into public.facility_members (id, facility_id, player_id, role, status, joined_via)
     values ($1, $2, $3, 'organizer', 'active', 'signup')
     on conflict (id) do nothing`,
    [ORGANIZER_MEMBER_ID, FACILITY_ID, ORGANIZER_PLAYER_ID],
  );
  console.log(`[seed] dev organizer ready: ${ORGANIZER_EMAIL} (organizer of the seed facility)`);

  // Southcoast's REAL weekly schedule as observed for the week of Sept 6-12, 2026.
  // Weekly recurrence CONFIRMED against a second observed week (Sept 2026).
  // Seasonal schedule changes are still expected — they surface as a template
  // edit, not a bug.
  // Skill bands are the club's labels verbatim (free text, never parsed).
  // Lines identical across days are merged into one template (weekdays array);
  // per-day divergence later requires a template SPLIT (future edit semantics).
  // Sunday Beginner cap deliberately null (source said "25?"); Wed Beginner is 25.
  // Unknown caps = null. ISO weekdays: 1=Mon .. 7=Sun.
  const TEMPLATES = [
    // [id-suffix, name, type, band label, weekdays, start, end, cap]
    ['01', 'Beginner',            'open_play', 'Beginner',            [7],    '09:00', '12:00', null],
    ['02', 'Beginner',            'open_play', 'Beginner',            [3],    '09:00', '12:00', 25],
    ['03', 'Intermediate',        'open_play', 'Intermediate',        [7],    '13:00', '16:00', 30],
    ['04', 'Adv-Inter',           'open_play', 'Adv-Inter',           [1],    '09:00', '12:00', null],
    ['05', 'Advancing Beginner',  'open_play', 'Advancing Beginner',  [1],    '12:30', '15:30', null],
    ['06', 'Intermediate',        'open_play', 'Intermediate',        [2, 4], '09:00', '12:00', 30],
    ['07', 'Low Intermediate',    'open_play', 'Low Intermediate',    [2, 5], '12:00', '15:00', 36],
    ['08', 'All Play',            'open_play', 'All Play',            [2],    '18:00', '21:00', 30],
    ['09', 'Adv-Inter',           'open_play', 'Adv-Inter',           [3],    '17:30', '20:30', null],
    ['10', 'Advanced 4.0+',       'open_play', 'Advanced 4.0+',       [4],    '18:00', '21:00', null],
    ['11', 'Intermediate',        'open_play', 'Intermediate',        [5],    '09:00', '12:00', null],
    ['12', 'Friday Night Out',    'social',    null,                  [5],    '17:00', '20:00', null],
    ['13', 'Advanced 4.0+',       'open_play', 'Advanced 4.0+',       [6],    '09:00', '12:00', null],
    ['14', 'Saturday Social',     'social',    null,                  [6],    '14:00', '17:00', 30],
  ];
  let templatesCreated = 0;
  for (const [suffix, name, type, band, weekdays, start, end, cap] of TEMPLATES) {
    const t = await client.query(
      `insert into public.session_templates
         (id, facility_id, name, session_type, skill_band_label, weekdays,
          start_time_local, end_time_local, capacity, created_by)
       values ($1, $2, $3, $4, $5, $6::smallint[], $7, $8, $9, $10)
       on conflict (id) do nothing`,
      [
        `d5eed000-0000-4000-a000-0000000003${suffix}`,
        FACILITY_ID, name, type, band, weekdays, start, end, cap, ORGANIZER_PLAYER_ID,
      ],
    );
    templatesCreated += t.rowCount;
  }
  console.log(`[seed] session templates created: ${templatesCreated} of ${TEMPLATES.length} (0 = already seeded)`);

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
