# CLAUDE.md — Pickleball Club Social Layer

*Working conventions for Claude Code on this project. Commit this at repo root. Keep it current — when a schema quirk or hard-won lesson emerges, it gets documented here immediately.*

## Project context

Member-to-member social/coordination layer for pickleball facilities, sitting alongside (not replacing) CourtReserve. POC targets one pilot facility. Strategy and architecture live in the Claude Project docs (01–03); this file is the day-to-day implementation contract.

## Methodology

- **One proven slice at a time.** Do not start slice N+1 until slice N's "proven when" condition is demonstrated. Do not build speculative scaffolding for future phases.
- **Investigate-and-propose before building** anything with unresolved unknowns (external file formats, third-party APIs, library choices). Spike, report findings, get sign-off, then implement.
- Small commits per working step; every slice ends in a deployable state.

## Hard rules

1. **RSVPs/crews/sessions are native data. Never model them as synced-in external state.**
2. **External system IDs (CourtReserve member IDs, etc.) are `external_ref` columns — never our primary keys.** All primary keys are our UUIDs.
3. **All ingestion is idempotent.** Re-running any import with the same input produces zero duplicates. Upsert keyed on external_ref, falling back to normalized email.
4. **Every ingestion run and every background job writes an audit row with a correlation_id.** Log matched/created/skipped counts.
5. **RLS on every table at creation time**, multi-tenant by facility_id. No "RLS sweep later."
6. **No payments code. No booking-engine code.** Deep links to the club's portal only.
7. **Scheduled jobs: verify cadence explicitly before deploy** (a prior project ran a "daily" job every minute for 16 months). State the cron expression in the PR description in plain English.
8. **No hardcoded club-specific content** (schedules, skill bands, facility names) in code — all configuration lives in the DB.

## Stack conventions

- Expo (React Native, latest stable SDK), TypeScript strict. Auth: Supabase OTP code entry, no magic-link deep links.
- Backend: Node/TypeScript Express on Render. Zod validation at every API boundary.
- Supabase Postgres. Migrations numbered sequentially (001, 002, ...), each with a one-line purpose comment. Never edit an applied migration.
- xlsx parsing server-side. Column mapping is per-facility data, not code.

## Environment

- Windows desktop primary; MacBook secondary. Anything with shell scripts must work on both (prefer npm scripts / node over bash-isms).
- Repos:
  - App: https://github.com/luckyrolls/NextFourApp
  - Backend: https://github.com/luckyrolls/NextFourBackEnd
- Supabase project ref: `zkxvalydqymacenulcdj` (URL: https://zkxvalydqymacenulcdj.supabase.co).
  Dedicated new project — not Moosii's.
- Supabase keys are the **new format** (`publishable` / `secret`), not legacy anon/service_role.
  The app uses the publishable key; the backend uses the secret key, which bypasses RLS and
  never leaves this repo's env.
- Migrations: numbered `.sql` files in `supabase/migrations/`, applied by `npm run migrate`
  (a Node runner, not the Supabase CLI — the CLI requires timestamped filenames and Docker).
  `npm run migrate:status` lists applied vs. pending. The runner checksums applied migrations,
  so editing one is a hard error rather than a convention.

## Schema quirks & lessons

*(Append as discovered. Empty is a good sign; undocumented is not.)*

**RLS verification must use the PUBLISHABLE key.** Both `service_role` (the secret
key) and the `postgres` role have the `BYPASSRLS` attribute — verified against the live
project — so any RLS test through the secret key or a direct DB connection passes
whether or not the policies work. `npm run verify:rls` signs in real test users with
the publishable key. `SUPABASE_PUBLISHABLE_KEY` in `.env` exists only for this.

**The app must never `select('*')` on `players`.** `email` and `auth_user_id` are
withheld from clients by a column-scoped grant (`select (id, display_name, created_at)`),
so `select('*')` — and any explicit select of `email` — fails with permission denied by
design. Always list columns. Same for updates: only `display_name` is client-writable.

**RLS policies must not read their own table directly.** A `facility_members` policy
that queries `facility_members` recurses (Postgres errors out). Membership lookups in
policies go through the `SECURITY DEFINER` helpers in the `app` schema
(`app.current_player_id()`, `app.my_facility_ids()`, `app.my_admin_facility_ids()`),
which are owned by `postgres` and bypass RLS. New policies in later slices should reuse
these, not re-derive membership.

**Extending an enum and using the new value cannot share one migration.** The runner
wraps each file in a single transaction, and Postgres only allows using a freshly added
enum value in the same transaction when the type itself was created there. So
`alter type ... add value 'x'` in 00N and the backfill using `'x'` in 00N+1.

**supabase-js v2.58+ requires a WebSocket at `createClient` time; Node 20 has none.**
The realtime client initializes in the SupabaseClient constructor and throws on Node 20
(`Node.js 20 detected without native WebSocket support`). Resolved by pinning Node 22
(native WebSocket) everywhere: `engines`, `.nvmrc`, and Render's `NODE_VERSION`. Local
dev must run Node 22 too — `nvm use` picks it up from `.nvmrc`; on Node 20 anything
that constructs a Supabase client (e.g. `npm run verify:rls`) crashes at startup.

**SheetJS must come from cdn.sheetjs.com, never the npm registry.** The npm `xlsx`
package is frozen at 0.18.5 — the exact version npm audit flags (prototype pollution +
ReDoS). Fixed builds ship only as CDN tarballs; package.json pins
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` and the lockfile carries its
integrity hash. Upgrades mean editing that URL, not `npm update`. Parse with
`{ defval: null, raw: false }` — the defaults silently drop empty cells' keys and leave
numeric cells as numbers.

**Imported phone / membership status have no destination columns yet.** The mapping
vocabulary accepts `phone` and `membership_status` so mappings can document the export,
but ingestion stores them verbatim in `import_rows.raw` only — interpreting club status
strings (Active/Frozen/Expired) would be hardcoded club semantics. Revisit when a real
export shows the actual vocabulary.

**session_type deviates from 02-architecture: it includes `social`.** Southcoast's
real schedule has social events (Friday Night Out, Saturday Social) that are not
open play, league, clinic, or crew sessions. Ruled in at enum creation (004).

**RLS variant #3 — backend-only tables.** `job_runs` has RLS ENABLED with ZERO
policies and an explicit `revoke all ... from anon, authenticated`. Nothing any
client role does can ever read or write it; the backend's secret key (BYPASSRLS)
is the only path. Use this variant for tables with no client-facing surface at all.
Variants: #1 member-scoped select via `app.my_facility_ids()` (facilities, sessions,
session_templates...), #2 admin-scoped via `app.my_admin_facility_ids()` (imports,
mappings, import_rows), #3 none.

**DB clock vs local clock: never stamp finished_at from `new Date()`.** `started_at`
defaults to the DATABASE clock; both `imports` and `job_runs` check
`finished_at >= started_at`. A local clock even slightly behind Supabase's makes a
fast run "finish before it started" and the finalize UPDATE fails its check — and
Postgres keeps microseconds while JS Date truncates to milliseconds, so a bare clamp
still loses. Use `finishedAtAfter(started_at)` (src/lib/time.ts). Found because a
job_runs finalize error went unchecked — check every write's error.

**GitHub Actions scheduling caveats.** The generate-sessions schedule is disabled
automatically after 60 days without repo activity (a push or manual dispatch
re-enables it), and scheduled runs can lag minutes-to-hours at busy times. The daily
horizon job tolerates both; do not put lag-sensitive work on Actions cron. The
workflow calls the endpoint with a 90s timeout and one retry for Render free-tier
cold starts.

**Job cadence (hard rule 7).** generate-sessions: once per day at 09:07 UTC (early
morning US-Eastern), cron `7 9 * * *`, plus inline on template CRUD and on demand
via POST /facilities/:id/generate-sessions. Not hourly; never every minute.

**Render — buildCommand must compile TypeScript, and must force dev dependencies.**
Two distinct failure modes, both seen:
1. A build command of `npm install` alone (Render's default for a service created in
   the dashboard rather than from the Blueprint) never runs `tsc`, so `dist/` does not
   exist and `npm run start` exits immediately with `MODULE_NOT_FOUND`.
2. Adding `npm run build` is not sufficient on its own. `render.yaml` sets
   `NODE_ENV=production`, and npm honours that by omitting `devDependencies` — where
   `typescript` lives. `npm ci && npm run build` therefore fails with `tsc: not found`.
   The build command must be `npm ci --include=dev && npm run build`.
Rule of thumb: if a build-time tool is in `devDependencies`, the deploy build command
has to ask for dev dependencies explicitly.

**Migrations must use the Supabase SESSION POOLER connection string, not Direct
connection.** Direct connection (`db.<project-ref>.supabase.co`) resolves to IPv6 only
and fails with `ENOTFOUND` on IPv4-only networks, which includes most home ISPs.
The session pooler host contains `pooler.supabase.com` and the user is
`postgres.<project-ref>` (not bare `postgres`). This is what `SUPABASE_DB_URL` in
`.env.example` documents.

## Open items

- **Player-row creation at signup is unresolved (deliberate 002 gap).** Clients have no
  INSERT on `players`, and nothing yet links a fresh `auth.users` signup to a `players`
  row or claims an existing shadow row by normalized email. Until a later slice decides
  the mechanism (backend endpoint vs. DB trigger), a newly signed-up user resolves to no
  player and sees zero rows everywhere.

- **Template edit semantics to design later**: RSVP carry-over when a time edit
  cancels-and-recreates future sessions (Slice 3), and template SPLIT when one
  merged multi-day line needs per-day divergence.
- **Southcoast weekly recurrence is assumed from one observed week** (Sept 6-12,
  2026) — verify against the club before the pilot.

## Definition of done per slice

- "Proven when" condition from 03-roadmap-slices.md demonstrated end-to-end
- Migrations applied cleanly to a fresh DB from 001
- RLS verified for new tables (test as anon + as wrong-facility member)
- CLAUDE.md updated if any quirk or convention emerged
