/**
 * Regenerates fixtures/members-report.sample.xlsx — a SYNTHETIC stand-in for a
 * CourtReserve Members Report export.
 *
 * ⚠️  The column headers here are GUESSES modeled on plausible CourtReserve report
 * columns. The real Southcoast export has not been obtained yet; when it is, this
 * fixture and the provisional column mapping must be revised against it, and any
 * differences recorded in CLAUDE.md. Nothing in this file is real member data.
 *
 * Deliberate anomalies for the ingestion spike/tests:
 *   row 3  duplicate email of row 1, different casing + surrounding whitespace
 *   row 6  has a Member ID but no email
 *   row 7  has NEITHER member ID nor email (unmatchable)
 *   row 8  non-numeric skill value ("3.5+" style club shorthand)
 *   row 9  empty phone + empty rating (empty-cell handling)
 *
 * Run: node fixtures/make-members-fixture.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const HEADERS = [
  'Member Id',
  'First Name',
  'Last Name',
  'Email',
  'Phone',
  'Rating',
  'Membership Status',
];

const ROWS = [
  ['CR-20001', 'Alice', 'Fixture', 'alice.fixture@example.com', '555-0101', '3.5', 'Active'],
  ['CR-20002', 'Bola', 'Sample', 'bola.sample@example.com', '555-0102', '4.0', 'Active'],
  // Duplicate of row 1's email — different casing and whitespace.
  ['CR-20003', 'Alicia', 'Fixture-Dupe', '  ALICE.FIXTURE@Example.com ', '555-0103', '3.0', 'Active'],
  ['CR-20004', 'Chen', 'Sample', 'chen.sample@example.com', '555-0104', '3.25', 'Frozen'],
  ['CR-20005', 'Dina', 'Sample', 'dina.sample@example.com', '555-0105', '4.5', 'Active'],
  // Member ID but no email.
  ['CR-20006', 'Emeka', 'Sample', null, '555-0106', '3.5', 'Active'],
  // Neither member ID nor email — unmatchable row.
  [null, 'Farah', 'Sample', null, '555-0107', '2.5', 'Active'],
  // Non-numeric skill value.
  ['CR-20008', 'Gus', 'Sample', 'gus.sample@example.com', '555-0108', '3.5+', 'Active'],
  // Empty phone and rating cells.
  ['CR-20009', 'Hana', 'Sample', 'hana.sample@example.com', null, null, 'Expired'],
  ['CR-20010', 'Ivan', 'Sample', 'ivan.sample@example.com', '555-0110', '3.0', 'Active'],
];

const sheet = XLSX.utils.aoa_to_sheet([HEADERS, ...ROWS]);
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, 'Members');

const out = join(dirname(fileURLToPath(import.meta.url)), 'members-report.sample.xlsx');
writeFileSync(out, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
console.log(`wrote ${out} (${ROWS.length} data rows)`);
