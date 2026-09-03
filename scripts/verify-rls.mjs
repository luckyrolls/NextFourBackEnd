/**
 * RLS verification — proves the 002 policies with the PUBLISHABLE key.
 *
 * The secret key must NOT be used for the assertions: service_role has BYPASSRLS,
 * so a secret-key test passes whether or not RLS works. The secret key and
 * SUPABASE_DB_URL are used only to build and tear down fixtures.
 *
 * Fixtures (all synthetic, all removed afterwards):
 *   facility A — test user 1 as plain member
 *   facility B — test user 2 as organizer, plus one imports row per facility
 *
 * Asserts:
 *   anon      reads nothing on all four tables
 *   user 1    sees facility A only; cannot see B's roster/players/facility
 *   user 1    (plain member) sees zero imports rows even for their own facility
 *   user 2    (organizer of B) sees B's imports row and not A's
 *   players   select('*') is refused (email/auth_user_id withheld by column grant)
 *   players   cross-row update touches 0 rows; email update is refused entirely
 *
 * Run: npm run verify:rls
 * Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_DB_URL.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, SUPABASE_DB_URL } =
  process.env;

for (const [name, value] of Object.entries({
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY,
  SUPABASE_DB_URL,
})) {
  if (!value) {
    console.error(`[verify-rls] ${name} is not set. See .env.example.`);
    process.exit(1);
  }
}

// Fixed fixture IDs (aa11f... prefix = owned by this script, deleted on exit).
const FACILITY_A = 'aa11f000-0000-4000-a000-00000000000a';
const FACILITY_B = 'aa11f000-0000-4000-a000-00000000000b';
const PLAYER_1 = 'aa11f000-0000-4000-a000-000000000101';
const PLAYER_2 = 'aa11f000-0000-4000-a000-000000000102';
const EMAIL_1 = 'rls.test.user1@example.com';
const EMAIL_2 = 'rls.test.user2@example.com';
const PASSWORD = `rls-test-${crypto.randomUUID()}`;

let failures = 0;
function check(condition, label, detail = '') {
  if (condition) {
    console.log(`  pass  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const admin = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const db = new pg.Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

async function destroyTestUsers() {
  // Look up by our fixture emails only — never touch other users.
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (user.email === EMAIL_1 || user.email === EMAIL_2) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }
}

async function teardown() {
  await db.query(`delete from public.imports where facility_id in ($1, $2)`, [FACILITY_A, FACILITY_B]);
  await db.query(`delete from public.facility_members where facility_id in ($1, $2)`, [FACILITY_A, FACILITY_B]);
  await db.query(`delete from public.players where id in ($1, $2)`, [PLAYER_1, PLAYER_2]);
  await db.query(`delete from public.facilities where id in ($1, $2)`, [FACILITY_A, FACILITY_B]);
  await destroyTestUsers();
}

try {
  // ------------------------------------------------------------------ setup
  await destroyTestUsers(); // clear leftovers from an interrupted earlier run

  const u1 = await admin.auth.admin.createUser({ email: EMAIL_1, password: PASSWORD, email_confirm: true });
  const u2 = await admin.auth.admin.createUser({ email: EMAIL_2, password: PASSWORD, email_confirm: true });
  if (u1.error || u2.error) {
    throw new Error(`could not create test users: ${u1.error?.message ?? u2.error?.message}`);
  }

  await db.query(
    `insert into public.facilities (id, name, timezone, external_system)
     values ($1, 'RLS Test Facility A (synthetic)', 'America/New_York', 'none'),
            ($2, 'RLS Test Facility B (synthetic)', 'America/New_York', 'none')
     on conflict (id) do nothing`,
    [FACILITY_A, FACILITY_B],
  );
  await db.query(
    `insert into public.players (id, email, display_name, auth_user_id)
     values ($1, $2, 'RLS Test User One', $3), ($4, $5, 'RLS Test User Two', $6)
     on conflict (id) do nothing`,
    [PLAYER_1, EMAIL_1, u1.data.user.id, PLAYER_2, EMAIL_2, u2.data.user.id],
  );
  await db.query(
    `insert into public.facility_members (facility_id, player_id, role, status, joined_via)
     values ($1, $2, 'member',    'active', 'signup'),
            ($3, $4, 'organizer', 'active', 'signup')
     on conflict (facility_id, player_id) do nothing`,
    [FACILITY_A, PLAYER_1, FACILITY_B, PLAYER_2],
  );
  await db.query(
    `insert into public.imports (facility_id, adapter, source_label, status)
     values ($1, 'report_upload', 'rls-test-a.xlsx', 'succeeded'),
            ($2, 'report_upload', 'rls-test-b.xlsx', 'succeeded')`,
    [FACILITY_A, FACILITY_B],
  );

  // ------------------------------------------------------------------- anon
  console.log('\n[verify-rls] as anon (publishable key, no session)');
  const anon = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const table of ['facilities', 'players', 'facility_members', 'imports']) {
    const cols = table === 'players' ? 'id, display_name' : '*';
    const { data, error } = await anon.from(table).select(cols);
    // Zero grants for anon: permission-denied is the expected shape; an empty
    // result would also mean "reads nothing" but flag which one we got.
    check(
      error !== null || data.length === 0,
      `${table}: reads nothing (${error ? 'permission denied' : '0 rows'})`,
      error ? '' : `got ${data?.length} rows`,
    );
  }

  // ---------------------------------------------------------------- user 1
  console.log('\n[verify-rls] as user 1 (member of facility A, publishable key session)');
  const c1 = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const s1 = await c1.auth.signInWithPassword({ email: EMAIL_1, password: PASSWORD });
  if (s1.error) throw new Error(`user 1 sign-in failed: ${s1.error.message}`);

  {
    const { data, error } = await c1.from('facilities').select('id, name');
    check(!error && data.length === 1 && data[0].id === FACILITY_A,
      'facilities: sees exactly facility A', error?.message ?? `got ${data?.length} rows`);
  }
  {
    const { data, error } = await c1.from('facilities').select('id').eq('id', FACILITY_B);
    check(!error && data.length === 0, 'facilities: facility B returns zero rows',
      error?.message ?? `got ${data?.length} rows`);
  }
  {
    const { data, error } = await c1.from('facility_members').select('id, facility_id');
    check(!error && data.length >= 1 && data.every((r) => r.facility_id === FACILITY_A),
      'facility_members: only facility A rows', error?.message ?? JSON.stringify(data));
    const { data: db2, error: eb2 } = await c1.from('facility_members').select('id').eq('facility_id', FACILITY_B);
    check(!eb2 && db2.length === 0, 'facility_members: facility B roster returns zero rows',
      eb2?.message ?? `got ${db2?.length} rows`);
  }
  {
    const { data, error } = await c1.from('players').select('id, display_name, created_at');
    check(!error && data.some((r) => r.id === PLAYER_1) && !data.some((r) => r.id === PLAYER_2),
      'players: sees self, not facility B player', error?.message ?? JSON.stringify(data));
  }
  {
    const { error } = await c1.from('players').select('*');
    check(error !== null, 'players: select(*) is refused (email withheld by column grant)');
    const { error: emailErr } = await c1.from('players').select('email');
    check(emailErr !== null, 'players: selecting email column is refused');
  }
  {
    const { data, error } = await c1.from('imports').select('id');
    check(!error && data.length === 0, 'imports: plain member sees zero rows',
      error?.message ?? `got ${data?.length} rows`);
  }
  {
    const upd = await c1.from('players').update({ display_name: 'Hacked' }).eq('id', PLAYER_2).select('id');
    check(!upd.error && upd.data.length === 0, 'players: cross-row update touches 0 rows',
      upd.error?.message ?? `touched ${upd.data?.length}`);
    const self = await c1.from('players').update({ display_name: 'RLS Test User One' }).eq('id', PLAYER_1).select('id');
    check(!self.error && self.data.length === 1, 'players: self display_name update works',
      self.error?.message ?? `touched ${self.data?.length}`);
    const em = await c1.from('players').update({ email: 'stolen@example.com' }).eq('id', PLAYER_1);
    check(em.error !== null, 'players: email update is refused (column grant)');
  }

  // ---------------------------------------------------------------- user 2
  console.log('\n[verify-rls] as user 2 (organizer of facility B)');
  const c2 = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const s2 = await c2.auth.signInWithPassword({ email: EMAIL_2, password: PASSWORD });
  if (s2.error) throw new Error(`user 2 sign-in failed: ${s2.error.message}`);

  {
    const { data, error } = await c2.from('facilities').select('id');
    check(!error && data.length === 1 && data[0].id === FACILITY_B,
      'facilities: sees exactly facility B', error?.message ?? `got ${data?.length} rows`);
  }
  {
    const { data, error } = await c2.from('imports').select('id, facility_id');
    check(!error && data.length === 1 && data[0].facility_id === FACILITY_B,
      'imports: organizer sees own facility row only', error?.message ?? JSON.stringify(data));
  }

  console.log(failures ? `\n[verify-rls] ${failures} FAILURE(S)\n` : '\n[verify-rls] All checks passed.\n');
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error(`\n[verify-rls] aborted: ${error.message}`);
  process.exitCode = 1;
} finally {
  await teardown().catch((e) => console.error(`[verify-rls] teardown issue: ${e.message}`));
  await db.end();
}
