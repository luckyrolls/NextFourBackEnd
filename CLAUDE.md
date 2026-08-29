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
  - Backend: https://github.com/luckyrolls/NextFourBackend
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

- [none yet]

## Definition of done per slice

- "Proven when" condition from 03-roadmap-slices.md demonstrated end-to-end
- Migrations applied cleanly to a fresh DB from 001
- RLS verified for new tables (test as anon + as wrong-facility member)
- CLAUDE.md updated if any quirk or convention emerged
