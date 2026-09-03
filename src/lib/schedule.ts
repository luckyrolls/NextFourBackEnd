import { Temporal } from '@js-temporal/polyfill';

/**
 * Pure schedule expansion — no I/O, so the DST behavior is testable directly.
 *
 * Semantics established by the Slice 2 spike:
 *  - (facility-local date, local wall time, IANA zone) -> instant, with
 *    disambiguation 'compatible': spring-forward gaps push forward, fall-back
 *    overlaps take the first occurrence. Deterministic on transition days.
 *  - end time at-or-before start time means the slot straddles midnight; the
 *    end lands on the next local date.
 *  - A spring-forward gap can collapse a slot inside the lost hour to zero
 *    length; such degenerate occurrences are dropped (callers count them).
 */

export interface TemplateRule {
  /** ISO weekdays, 1=Monday .. 7=Sunday. */
  weekdays: number[];
  /** 'HH:MM' or 'HH:MM:SS' local wall time. */
  startTimeLocal: string;
  endTimeLocal: string;
  /** Facility-local calendar dates, inclusive; null = unbounded. */
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}

export interface Occurrence {
  /** ISO instant strings (UTC) for timestamptz columns. */
  startsAt: string;
  endsAt: string;
  /** The facility-local date the occurrence belongs to. */
  localDate: string;
}

export function occurrenceInstants(
  localDate: string,
  startTimeLocal: string,
  endTimeLocal: string,
  timeZone: string,
): Occurrence | null {
  const date = Temporal.PlainDate.from(localDate);
  const startTime = Temporal.PlainTime.from(startTimeLocal);
  const endTime = Temporal.PlainTime.from(endTimeLocal);

  const start = date.toZonedDateTime({ timeZone, plainTime: startTime });
  const endDate = Temporal.PlainTime.compare(endTime, startTime) <= 0 ? date.add({ days: 1 }) : date;
  const end = endDate.toZonedDateTime({ timeZone, plainTime: endTime });

  if (Temporal.Instant.compare(end.toInstant(), start.toInstant()) <= 0) {
    return null; // degenerate: collapsed by a spring-forward gap
  }
  return {
    startsAt: start.toInstant().toString(),
    endsAt: end.toInstant().toString(),
    localDate,
  };
}

/**
 * Expands one template rule over [fromDate, fromDate + days) in the facility's
 * zone, honouring the effective window. fromDate is a facility-local date.
 * degenerate counts occurrences collapsed by a spring-forward gap.
 */
export function expandRule(
  rule: TemplateRule,
  timeZone: string,
  fromDate: string,
  days: number,
): { occurrences: Occurrence[]; degenerate: number } {
  const from = Temporal.PlainDate.from(fromDate);
  const effFrom = rule.effectiveFrom === null ? null : Temporal.PlainDate.from(rule.effectiveFrom);
  const effUntil = rule.effectiveUntil === null ? null : Temporal.PlainDate.from(rule.effectiveUntil);

  const occurrences: Occurrence[] = [];
  let degenerate = 0;
  for (let i = 0; i < days; i++) {
    const date = from.add({ days: i });
    if (!rule.weekdays.includes(date.dayOfWeek)) continue;
    if (effFrom !== null && Temporal.PlainDate.compare(date, effFrom) < 0) continue;
    if (effUntil !== null && Temporal.PlainDate.compare(date, effUntil) > 0) continue;
    const occ = occurrenceInstants(date.toString(), rule.startTimeLocal, rule.endTimeLocal, timeZone);
    if (occ !== null) occurrences.push(occ);
    else degenerate += 1;
  }
  return { occurrences, degenerate };
}

/** Today's calendar date on the facility's wall clock. */
export function localToday(timeZone: string): string {
  return Temporal.Now.plainDateISO(timeZone).toString();
}

/** fromDate + n days, as a local date string. */
export function addDays(localDate: string, n: number): string {
  return Temporal.PlainDate.from(localDate).add({ days: n }).toString();
}
