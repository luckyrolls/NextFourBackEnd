-- 004_schedule_tables.sql — Adds session_templates, sessions and job_runs (RLS in this migration) for the recurring-schedule generator.

-- Rulings baked in (Slice 2 GO):
--   * session_type includes 'social' — a deliberate deviation from 02-architecture's
--     v1 list (Southcoast's real schedule has social events). Documented in CLAUDE.md.
--   * registration_mode / external_event_ref DEFERRED to Slice 3 (additive later).
--   * Reconciliation cancels (status), never deletes — future RSVPs hang off sessions.
--   * job_runs is backend-only: RLS variant #3 (enabled + zero policies + revoked).

create type public.session_type   as enum ('open_play', 'league', 'clinic', 'crew_session', 'social');
create type public.session_source as enum ('native', 'recurring_template', 'import');
create type public.session_status as enum ('scheduled', 'cancelled');
create type public.job_run_status as enum ('running', 'succeeded', 'failed');

-- One row per organizer schedule line ("Intermediate, Tue/Thu 9-12, cap 30").
-- Weekdays are ISO (1=Mon .. 7=Sun) in an array: one line, several days.
-- end_time_local <= start_time_local means the slot straddles midnight.
create table public.session_templates (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facilities (id) on delete cascade,
  name             text not null,
  session_type     public.session_type not null default 'open_play',
  skill_band_label text,            -- free-text club label ("Adv-Inter"); never parsed
  weekdays         smallint[] not null
                     check (array_length(weekdays, 1) >= 1
                            and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  start_time_local time not null,
  end_time_local   time not null,
  capacity         integer check (capacity > 0),  -- copied to sessions at generation
  active           boolean not null default true, -- deactivate = soft; rows never deleted
  effective_from   date,                          -- facility-local dates, inclusive
  effective_until  date,
  created_by       uuid references public.players (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (effective_from is null or effective_until is null or effective_until >= effective_from)
);

create index session_templates_facility_idx on public.session_templates (facility_id);

-- Native data (hard rule 1). facility_id is denormalized even for template-sourced
-- rows so RLS stays uniform and native one-off sessions need no template.
-- session_type / skill_band_label / capacity are COPIED at generation: a template
-- edit never rewrites already-generated history.
create table public.sessions (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facilities (id) on delete cascade,
  template_id      uuid references public.session_templates (id) on delete set null,
  source           public.session_source not null,
  session_type     public.session_type not null,
  skill_band_label text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  capacity         integer check (capacity > 0),
  status           public.session_status not null default 'scheduled',
  created_at       timestamptz not null default now(),
  check (ends_at > starts_at),
  -- The generator's idempotency key: re-running inserts nothing that exists.
  -- NULL template_id (native one-offs) is unconstrained (NULLs are distinct).
  unique (template_id, starts_at)
);

create index sessions_facility_starts_idx on public.sessions (facility_id, starts_at);

-- Generalized job audit (hard rule 4): one row per run of any background job,
-- with correlation_id and per-run stats. The future CourtReserve sync worker
-- writes here too. imports stays as the adapter-specific ingestion audit.
create table public.job_runs (
  id             uuid primary key default gen_random_uuid(),
  job_name       text not null,
  correlation_id uuid not null default gen_random_uuid(),
  status         public.job_run_status not null default 'running',
  stats          jsonb,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz check (finished_at is null or finished_at >= started_at)
);

create index job_runs_name_started_idx on public.job_runs (job_name, started_at desc);

-- ---------------------------------------------------------------------------
-- Grants — second-layer pattern from 002/003
-- ---------------------------------------------------------------------------

revoke all on public.session_templates, public.sessions, public.job_runs
  from anon, authenticated;

-- Members read their facility's schedule AND its template lines (ruling 4:
-- member-read; a weekly-schedule screen can render straight from templates).
grant select on public.session_templates, public.sessions to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — enabled here, in the creating migration, per hard rule
-- ---------------------------------------------------------------------------

alter table public.session_templates enable row level security;
alter table public.sessions          enable row level security;
alter table public.job_runs          enable row level security;

create policy session_templates_select_member on public.session_templates
  for select to authenticated
  using (facility_id in (select app.my_facility_ids()));

create policy sessions_select_member on public.sessions
  for select to authenticated
  using (facility_id in (select app.my_facility_ids()));

-- job_runs: RLS variant #3 — enabled with ZERO policies and zero grants.
-- No client can read or write it under any future policy mistake; the backend's
-- secret key (BYPASSRLS) is the only path. No create policy statements: that is
-- the point.
