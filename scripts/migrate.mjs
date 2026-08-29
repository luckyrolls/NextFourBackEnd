/**
 * Migration runner — applies supabase/migrations/NNN_*.sql in numeric order.
 *
 * Cross-platform by construction: plain Node, no shell, no Docker, no Supabase CLI.
 *   npm run migrate          apply every pending migration
 *   npm run migrate:status   list applied/pending without changing anything
 *
 * Guarantees:
 *   - Applied migrations are recorded in public.schema_migrations, so re-running is a no-op.
 *   - Each migration runs inside a transaction; a failure rolls back and nothing is recorded.
 *   - A sha256 checksum is stored per migration. Editing an applied migration is a hard
 *     error, mechanically enforcing the "never edit an applied migration" rule.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import pg from 'pg';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const FILENAME_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

const statusOnly = process.argv.includes('--status');

function fail(message) {
  console.error(`\n[migrate] ${message}\n`);
  process.exit(1);
}

function loadMigrations() {
  const entries = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));

  const migrations = entries.map((filename) => {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      fail(
        `Migration filename "${filename}" does not match NNN_snake_case_name.sql ` +
          '(e.g. 002_facilities.sql).',
      );
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    return {
      version: match[1],
      filename,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    };
  });

  migrations.sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }));

  const seen = new Set();
  for (const m of migrations) {
    if (seen.has(m.version)) fail(`Duplicate migration number ${m.version}.`);
    seen.add(m.version);
  }

  return migrations;
}

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    fail(
      'SUPABASE_DB_URL is not set.\n' +
        '  Supabase dashboard > Connect > Session pooler, then put the connection string ' +
        'in .env (see .env.example).\n' +
        '  It contains the database password, so it stays local — it is NOT needed in Render.',
    );
  }

  const migrations = loadMigrations();
  if (migrations.length === 0) fail(`No migrations found in ${MIGRATIONS_DIR}.`);

  const client = new pg.Client({
    connectionString,
    // Supabase terminates TLS with a certificate chain we do not bundle locally.
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        version     text primary key,
        filename    text        not null,
        checksum    text        not null,
        applied_at  timestamptz not null default now()
      );
    `);

    const { rows } = await client.query(
      'select version, filename, checksum, applied_at from public.schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.version, row]));

    // Enforce the "never edit an applied migration" rule.
    for (const m of migrations) {
      const record = applied.get(m.version);
      if (record && record.checksum !== m.checksum) {
        fail(
          `${m.filename} has changed since it was applied.\n` +
            '  Applied migrations are immutable. Add a new numbered migration instead.\n' +
            `  expected sha256 ${record.checksum}\n` +
            `  found    sha256 ${m.checksum}`,
        );
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (statusOnly) {
      console.log('\n[migrate] status\n');
      for (const m of migrations) {
        const record = applied.get(m.version);
        console.log(
          record
            ? `  applied  ${m.filename}  ${new Date(record.applied_at).toISOString()}`
            : `  pending  ${m.filename}`,
        );
      }
      console.log(`\n  ${applied.size} applied, ${pending.length} pending\n`);
      return;
    }

    if (pending.length === 0) {
      console.log(`[migrate] Up to date — ${migrations.length} migration(s) already applied.`);
      return;
    }

    for (const m of pending) {
      process.stdout.write(`[migrate] applying ${m.filename} ... `);
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query(
          'insert into public.schema_migrations (version, filename, checksum) values ($1, $2, $3)',
          [m.version, m.filename, m.checksum],
        );
        await client.query('commit');
        console.log('ok');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        console.log('FAILED');
        fail(`${m.filename} failed and was rolled back.\n  ${error.message}`);
      }
    }

    console.log(`[migrate] Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
