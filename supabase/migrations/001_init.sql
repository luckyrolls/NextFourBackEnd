-- 001_init.sql — Establishes the numbered migration chain and guarantees gen_random_uuid() exists for the UUID primary keys every later slice depends on.

-- No tables in this migration by design. Schema arrives slice-by-slice, and every
-- table gets RLS enabled in the same migration that creates it.

-- Postgres 13+ ships gen_random_uuid() in core and Supabase pre-installs pgcrypto,
-- so this is a no-op on the hosted project. It is kept so the chain also applies
-- cleanly from 001 against a plain Postgres instance. Re-running is safe.
create extension if not exists pgcrypto;
