/**
 * Schedule expansion tests against the compiled lib (run `npm run build` first).
 * Pure functions, no DB: DST correctness, midnight straddle, degenerate slots,
 * effective windows, and the Southcoast fixture's expected 14-day yield.
 *
 * Run: npm run test:schedule
 */
import { expandRule, occurrenceInstants } from '../dist/lib/schedule.js';

const TZ = 'America/New_York';
let failures = 0;
function check(condition, label, detail = '') {
  if (condition) console.log(`  pass  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[test-schedule] DST fall-back 2026-11-01: Tue/Thu 19:00-21:00');
const dst = expandRule(
  { weekdays: [2, 4], startTimeLocal: '19:00', endTimeLocal: '21:00', effectiveFrom: null, effectiveUntil: null },
  TZ, '2026-10-26', 14,
);
check(dst.occurrences.length === 4 && dst.degenerate === 0, 'four occurrences, none degenerate',
  JSON.stringify(dst));
const expect = [
  ['2026-10-27T23:00:00Z', '2026-10-28T01:00:00Z'], // EDT, UTC-4
  ['2026-10-29T23:00:00Z', '2026-10-30T01:00:00Z'],
  ['2026-11-04T00:00:00Z', '2026-11-04T02:00:00Z'], // EST, UTC-5 — 7pm shifted 1h in UTC
  ['2026-11-06T00:00:00Z', '2026-11-06T02:00:00Z'],
];
expect.forEach(([s, e], i) => {
  const occ = dst.occurrences[i];
  check(occ?.startsAt === s && occ?.endsAt === e, `occurrence ${i + 1}: ${s} .. ${e}`,
    `got ${occ?.startsAt} .. ${occ?.endsAt}`);
});

console.log('\n[test-schedule] midnight straddle: Fri 22:00-00:00 across the fall-back weekend');
const straddle = expandRule(
  { weekdays: [5], startTimeLocal: '22:00', endTimeLocal: '00:00', effectiveFrom: null, effectiveUntil: null },
  TZ, '2026-10-26', 14,
);
check(
  straddle.occurrences[0]?.startsAt === '2026-10-31T02:00:00Z' && straddle.occurrences[0]?.endsAt === '2026-10-31T04:00:00Z',
  'pre-transition Friday ends local midnight (UTC-4)', JSON.stringify(straddle.occurrences[0]));
check(
  straddle.occurrences[1]?.startsAt === '2026-11-07T03:00:00Z' && straddle.occurrences[1]?.endsAt === '2026-11-07T05:00:00Z',
  'post-transition Friday ends local midnight (UTC-5)', JSON.stringify(straddle.occurrences[1]));

console.log('\n[test-schedule] spring-forward degenerate: 02:30-03:30 on 2027-03-14');
check(occurrenceInstants('2027-03-14', '02:30', '03:30', TZ) === null,
  'slot inside the lost hour is rejected as degenerate');
const spring = expandRule(
  { weekdays: [7], startTimeLocal: '02:30', endTimeLocal: '03:30', effectiveFrom: null, effectiveUntil: null },
  TZ, '2027-03-08', 14,
);
check(spring.occurrences.length === 1 && spring.degenerate === 1,
  'expansion drops it and counts it', JSON.stringify(spring));

console.log('\n[test-schedule] effective window clipping');
const clipped = expandRule(
  { weekdays: [2, 4], startTimeLocal: '19:00', endTimeLocal: '21:00', effectiveFrom: '2026-10-29', effectiveUntil: '2026-11-03' },
  TZ, '2026-10-26', 14,
);
check(clipped.occurrences.length === 2
  && clipped.occurrences[0]?.localDate === '2026-10-29' && clipped.occurrences[1]?.localDate === '2026-11-03',
  'only in-window dates survive', JSON.stringify(clipped.occurrences.map((o) => o.localDate)));

console.log('\n[test-schedule] Southcoast fixture yield: 14 templates, 14 full days = 32 sessions');
// Mirrors the seed (name/type omitted; only expansion inputs matter here).
const SOUTHCOAST = [
  { weekdays: [7], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Beginner Sun
  { weekdays: [3], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Beginner Wed
  { weekdays: [7], startTimeLocal: '13:00', endTimeLocal: '16:00' }, // Intermediate Sun
  { weekdays: [1], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Adv-Inter Mon
  { weekdays: [1], startTimeLocal: '12:30', endTimeLocal: '15:30' }, // Advancing Beginner Mon
  { weekdays: [2, 4], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Intermediate Tue/Thu
  { weekdays: [2, 5], startTimeLocal: '12:00', endTimeLocal: '15:00' }, // Low Intermediate Tue/Fri
  { weekdays: [2], startTimeLocal: '18:00', endTimeLocal: '21:00' }, // All Play Tue
  { weekdays: [3], startTimeLocal: '17:30', endTimeLocal: '20:30' }, // Adv-Inter Wed
  { weekdays: [4], startTimeLocal: '18:00', endTimeLocal: '21:00' }, // Advanced 4.0+ Thu
  { weekdays: [5], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Intermediate Fri
  { weekdays: [5], startTimeLocal: '17:00', endTimeLocal: '20:00' }, // Friday Night Out
  { weekdays: [6], startTimeLocal: '09:00', endTimeLocal: '12:00' }, // Advanced 4.0+ Sat
  { weekdays: [6], startTimeLocal: '14:00', endTimeLocal: '17:00' }, // Saturday Social
];
const total = SOUTHCOAST.reduce(
  (n, r) => n + expandRule({ ...r, effectiveFrom: null, effectiveUntil: null }, TZ, '2026-09-07', 14).occurrences.length,
  0,
);
check(total === 32, `14 full days yield exactly 32 sessions (got ${total})`);

console.log(failures ? `\n[test-schedule] ${failures} FAILURE(S)\n` : '\n[test-schedule] All checks passed.\n');
if (failures) process.exitCode = 1;
