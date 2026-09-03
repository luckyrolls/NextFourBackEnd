-- 003_ingestion_tables.sql — Adds facility_column_mappings and import_rows (RLS in this migration) plus imports.column_mapping_id for the xlsx ingestion pipeline.

-- Column mappings are per-facility DATA, not code (02-architecture). Versioned and
-- append-only: a changed mapping is a NEW version, so every import keeps pointing at
-- exactly the mapping that produced it. header_signature records the verbatim header
-- row the mapping was built against; an upload whose headers differ is refused (409)
-- instead of silently mis-mapping.
create table public.facility_column_mappings (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facilities (id) on delete cascade,
  version          integer not null check (version >= 1),
  -- canonical field -> source header, e.g. {"email": "Email", "external_ref": "Member Id"}.
  -- Canonical-side vocabulary is enforced at the API boundary (Zod), not here.
  mapping          jsonb not null,
  header_signature text[] not null,
  note             text,
  created_at       timestamptz not null default now(),
  unique (facility_id, version)
);

create type public.import_row_outcome as enum ('matched', 'created', 'skipped');

-- One row per source-spreadsheet row: verbatim raw capture plus per-row outcome.
-- Chosen over an imports.raw_rows jsonb blob so the audit trail is queryable
-- (which rows skipped and why, which player each row resolved to) and replayable.
create table public.import_rows (
  id          uuid primary key default gen_random_uuid(),
  import_id   uuid not null references public.imports (id) on delete cascade,
  row_number  integer not null check (row_number >= 1), -- 1 = first data row
  raw         jsonb not null,                           -- parsed row, verbatim
  outcome     public.import_row_outcome not null,
  skip_reason text check ((outcome = 'skipped') = (skip_reason is not null)),
  player_id   uuid references public.players (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (import_id, row_number)
);

create index import_rows_player_id_idx on public.import_rows (player_id);

-- Which mapping version produced a given run. Null for adapters that do not map
-- spreadsheet columns (e.g. the future CourtReserve API sync).
alter table public.imports
  add column column_mapping_id uuid references public.facility_column_mappings (id);

-- ---------------------------------------------------------------------------
-- Grants — same second-layer pattern as 002
-- ---------------------------------------------------------------------------

revoke all on public.facility_column_mappings, public.import_rows from anon, authenticated;
grant select on public.facility_column_mappings, public.import_rows to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — enabled here, in the creating migration, per hard rule
-- ---------------------------------------------------------------------------
-- Both tables are ingestion audit/config: organizer/owner eyes only, like imports.
-- All writes go through the backend (secret key); clients have no write policies.

alter table public.facility_column_mappings enable row level security;
alter table public.import_rows              enable row level security;

create policy facility_column_mappings_select_admin on public.facility_column_mappings
  for select to authenticated
  using (facility_id in (select app.my_admin_facility_ids()));

-- Scoped through imports; that subquery runs under imports' own admin-only RLS,
-- and imports' policy resolves membership via the app.* helpers (no recursion).
create policy import_rows_select_admin on public.import_rows
  for select to authenticated
  using (
    import_id in (
      select i.id from public.imports i
      where i.facility_id in (select app.my_admin_facility_ids())
    )
  );
