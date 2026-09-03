/**
 * Dev CLI for the ingestion endpoints: sign in as the seeded dev organizer
 * (publishable key), upload an xlsx to POST /facilities/:id/imports, and print
 * the audit response. If the facility has no column mapping yet (409), posts
 * the fixture's provisional mapping first, then retries.
 *
 * Run: npm run import:dev [-- <path-to-xlsx> <facilityId>]
 * Defaults: fixtures/members-report.sample.xlsx into the seed facility.
 * Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEV_ORGANIZER_PASSWORD; the
 * server must be running (BASE_URL overrides http://localhost:PORT).
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEV_ORGANIZER_PASSWORD } = process.env;
for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEV_ORGANIZER_PASSWORD })) {
  if (!value) {
    console.error(`[import:dev] ${name} is not set. See .env.example (and run npm run seed:dev first).`);
    process.exit(1);
  }
}

const filePath = process.argv[2] ?? 'fixtures/members-report.sample.xlsx';
const facilityId = process.argv[3] ?? 'd5eed000-0000-4000-a000-000000000001'; // seed facility
const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

// Provisional mapping for the synthetic fixture's GUESSED headers. Real
// facilities get their mappings via the 409 detectedHeaders flow, not from here.
const FIXTURE_MAPPING = {
  external_ref: 'Member Id',
  first_name: 'First Name',
  last_name: 'Last Name',
  email: 'Email',
  phone: 'Phone',
  skill_level_raw: 'Rating',
  membership_status: 'Membership Status',
};

const authClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const signIn = await authClient.auth.signInWithPassword({
  email: 'dev.organizer@example.com',
  password: DEV_ORGANIZER_PASSWORD,
});
if (signIn.error) {
  console.error(`[import:dev] sign-in failed: ${signIn.error.message} — did seed:dev run?`);
  process.exit(1);
}
const token = signIn.data.session.access_token;
console.log('[import:dev] signed in as dev.organizer@example.com');

async function uploadFile() {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(filePath)]), basename(filePath));
  const response = await fetch(`${baseUrl}/facilities/${facilityId}/imports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

let result = await uploadFile();

if (result.status === 409 && result.body.error === 'no_column_mapping') {
  console.log('[import:dev] no mapping yet; detected headers:', JSON.stringify(result.body.detectedHeaders));
  const mapResponse = await fetch(`${baseUrl}/facilities/${facilityId}/column-mappings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mapping: FIXTURE_MAPPING,
      headerSignature: result.body.detectedHeaders,
      note: 'provisional mapping from synthetic fixture — revise against the real export',
    }),
  });
  const mapBody = await mapResponse.json();
  if (mapResponse.status !== 201) {
    console.error(`[import:dev] mapping creation failed (${mapResponse.status}):`, JSON.stringify(mapBody));
    process.exit(1);
  }
  console.log(`[import:dev] created mapping v${mapBody.version}; retrying upload`);
  result = await uploadFile();
}

console.log(`[import:dev] HTTP ${result.status}`);
console.log(JSON.stringify(result.body, null, 2));
if (result.status !== 201) process.exit(1);
