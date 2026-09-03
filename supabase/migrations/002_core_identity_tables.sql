-- 002_core_identity_tables.sql — Creates facilities, players, facility_members and imports with RLS enabled and policies in this same migration.

-- Design notes (signed off before writing):
--   * All primary keys are OUR uuids; external system IDs live in nullable external_ref.
--   * Identity chain for RLS: auth.uid() -> players.auth_user_id -> facility_members -> facility_id.
--   * Membership lookups inside policies route through SECURITY DEFINER helpers in the
--     `app` schema (owned by postgres, BYPASSRLS) — a facility_members policy that read
--     facility_members directly would recurse.
--   * anon: zero policies AND zero grants — reads nothing, writes nothing.
--   * Clients get NO insert/delete anywhere this slice; players.email and
--     players.auth_user_id are withheld from clients via column-scoped SELECT.

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
-- Quirk (documented in CLAUDE.md): a value ADDed to one of these enums by a later
-- migration cannot be USED in that same migration — the runner wraps each file in
-- one transaction, and Postgres only allows same-transaction use when the type
-- itself was created in that transaction. Extend-then-backfill must span two files.

create type public.external_system as enum ('courtreserve', 'podplay', 'none');
create type public.member_role     as enum ('member', 'organizer', 'owner');
create type public.member_status   as enum ('invited', 'active', 'inactive');
create type public.joined_via      as enum ('import', 'signup', 'invite');
create type public.import_adapter  as enum ('report_upload', 'courtreserve_api');
create type public.import_status   as enum ('running', 'succeeded', 'failed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.facilities (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  timezone        text not null, -- IANA zone name, e.g. 'America/New_York'
  external_system public.external_system not null default 'none',
  portal_url      text,
  created_at      timestamptz not null default now()
);

create table public.players (
  id           uuid primary key default gen_random_uuid(),
  -- Globally unique: one human = one players row across all facilities
  -- (facility_members is the per-facility join). Nullable: import upsert falls
  -- back to email but is keyed on external_ref, so a row can exist without one.
  -- Stored normalized; the check makes an unnormalized write fail loudly.
  email        text unique check (email = lower(btrim(email))),
  display_name text not null,
  -- Null = shadow record created by import before the person signs up.
  auth_user_id uuid unique references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table public.facility_members (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facilities (id) on delete cascade,
  player_id       uuid not null references public.players (id) on delete cascade,
  role            public.member_role not null default 'member',
  status          public.member_status not null default 'active',
  external_ref    text,        -- external system member ID; NEVER our key
  skill_level_raw text,        -- club raw value, verbatim
  skill_band      text,        -- normalized band; null until mapping exists
  joined_via      public.joined_via not null,
  created_at      timestamptz not null default now(),
  unique (facility_id, player_id),
  unique (facility_id, external_ref)
);

comment on column public.facility_members.status is
  'Roster status, not signup status: imported shadow members are active.';

create index facility_members_player_id_idx on public.facility_members (player_id);

create table public.imports (
  id             uuid primary key default gen_random_uuid(),
  facility_id    uuid not null references public.facilities (id) on delete cascade,
  adapter        public.import_adapter not null,
  source_label   text not null, -- filename or endpoint description
  correlation_id uuid not null default gen_random_uuid(),
  rows_matched   integer not null default 0 check (rows_matched >= 0),
  rows_created   integer not null default 0 check (rows_created >= 0),
  rows_skipped   integer not null default 0 check (rows_skipped >= 0),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz check (finished_at is null or finished_at >= started_at),
  status         public.import_status not null default 'running'
);

create index imports_facility_started_idx on public.imports (facility_id, started_at desc);

-- ---------------------------------------------------------------------------
-- RLS helpers — app schema, not exposed over PostgREST
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER + owned by postgres (BYPASSRLS): these read facility_members
-- without triggering its own policies, which is what breaks the recursion.
-- search_path is pinned empty, so every reference is schema-qualified.

create schema app;

create function app.current_player_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.id from public.players p where p.auth_user_id = (select auth.uid())
$$;

create function app.my_facility_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select fm.facility_id
  from public.facility_members fm
  where fm.player_id = (select app.current_player_id())
    and fm.status = 'active'
$$;

create function app.my_admin_facility_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select fm.facility_id
  from public.facility_members fm
  where fm.player_id = (select app.current_player_id())
    and fm.status = 'active'
    and fm.role in ('organizer', 'owner')
$$;

-- Functions default to EXECUTE for PUBLIC; tighten to authenticated only.
revoke all on function app.current_player_id()     from public, anon;
revoke all on function app.my_facility_ids()       from public, anon;
revoke all on function app.my_admin_facility_ids() from public, anon;
grant usage on schema app to authenticated;
grant execute on function app.current_player_id()     to authenticated;
grant execute on function app.my_facility_ids()       to authenticated;
grant execute on function app.my_admin_facility_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Grants — second layer under RLS
-- ---------------------------------------------------------------------------
-- Supabase default privileges hand ALL on new public tables to anon and
-- authenticated. Revoke everything, then grant back exactly what this slice
-- allows, so a future policy mistake still cannot open a write path.
-- service_role keeps its default ALL grant (the backend secret key).

revoke all on public.facilities, public.players, public.facility_members, public.imports
  from anon, authenticated;

grant select on public.facilities, public.facility_members, public.imports to authenticated;

-- players is column-scoped: email and auth_user_id never reach clients.
-- The app must select explicit columns — select('*') fails by design.
grant select (id, display_name, created_at) on public.players to authenticated;
grant update (display_name)                 on public.players to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — enabled here, in the creating migration, per hard rule
-- ---------------------------------------------------------------------------

alter table public.facilities       enable row level security;
alter table public.players          enable row level security;
alter table public.facility_members enable row level security;
alter table public.imports          enable row level security;

-- facilities: members read their own facilities; no client writes.
create policy facilities_select_member on public.facilities
  for select to authenticated
  using (id in (select app.my_facility_ids()));

-- players: self plus co-members of any shared facility. The facility_members
-- subquery runs under that table's own RLS, so it already scopes to the caller.
create policy players_select_co_member on public.players
  for select to authenticated
  using (
    id = (select app.current_player_id())
    or id in (
      select fm.player_id
      from public.facility_members fm
      where fm.facility_id in (select app.my_facility_ids())
    )
  );

-- players: self-update only; column grant above narrows it to display_name.
create policy players_update_self on public.players
  for update to authenticated
  using (id = (select app.current_player_id()))
  with check (id = (select app.current_player_id()));

-- facility_members: members see their facilities' rosters; no client writes.
create policy facility_members_select_member on public.facility_members
  for select to authenticated
  using (facility_id in (select app.my_facility_ids()));

-- imports: audit rows visible to organizers/owners of the facility only.
create policy imports_select_admin on public.imports
  for select to authenticated
  using (facility_id in (select app.my_admin_facility_ids()));

-- Deliberate gaps (documented in CLAUDE.md open items):
--   * No INSERT path on players — signup does not yet create/claim a player row.
--   * No client INSERT/UPDATE/DELETE anywhere; ingestion and admin flows arrive
--     in later slices through the backend (secret key), which bypasses RLS.
