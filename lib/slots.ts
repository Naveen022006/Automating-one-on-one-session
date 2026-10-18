import { DateTime } from "luxon";
import { APP_TIME_ZONE } from "@/lib/india";

export interface Rule {
  weekday: number; // ISO: 1 = Monday ... 7 = Sunday
  startTime: string; // "HH:mm" wall clock in `timezone`
  endTime: string;
  timezone: string;
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/**
 * Candidate slot start times (UTC) whose start falls in [from, to).
 * Slots are back-to-back, `durationMin` long, and must fit inside a rule window.
 * Rules are evaluated in their own stored timezone. New rules are always saved in Asia/Kolkata (IST, no DST; the API forces it,
 * doc/14-india-localisation.md); a rule saved before that in another zone keeps producing the same instants, DST shifts included.
 *
 * `blockedDates` is an optional set of "YYYY-MM-DD" calendar days the influencer has blocked off; a rule day
 * whose date (in the rule's own timezone) is in the set produces no slots. Passing the blocked days in keeps
 * this function pure and unit-testable - the query layer loads them from the DB and hands them over.
 */
export function generateSlots(
  rules: Rule[],
  durationMin: number,
  from: Date,
  to: Date,
  blockedDates: ReadonlySet<string> = new Set(),
): Date[] {
  const out = new Map<number, Date>();
  for (const rule of rules) {
    const zone = rule.timezone;
    // Walk the rule-timezone calendar days that overlap [from, to), with a day of slack.
    let day = DateTime.fromJSDate(from, { zone }).startOf("day").minus({ days: 1 });
    const last = DateTime.fromJSDate(to, { zone }).startOf("day").plus({ days: 1 });
    for (; day <= last; day = day.plus({ days: 1 })) {
      if (day.weekday !== rule.weekday) continue;
      const date = day.toISODate();
      // A blocked day yields no slots, so customers cannot book it.
      if (date && blockedDates.has(date)) continue;
      const windowStart = DateTime.fromISO(`${date}T${rule.startTime}`, { zone });
      const windowEnd = DateTime.fromISO(`${date}T${rule.endTime}`, { zone });
      if (!windowStart.isValid || !windowEnd.isValid) continue;
      for (
        let s = windowStart;
        s.plus({ minutes: durationMin }) <= windowEnd;
        s = s.plus({ minutes: durationMin })
      ) {
        const ms = s.toMillis();
        if (ms >= from.getTime() && ms < to.getTime()) out.set(ms, new Date(ms));
      }
    }
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

export function isSlotStart(
  rules: Rule[],
  durationMin: number,
  start: Date,
  blockedDates: ReadonlySet<string> = new Set(),
): boolean {
  return generateSlots(rules, durationMin, start, new Date(start.getTime() + 1), blockedDates).length === 1;
}

/**
 * The set of "YYYY-MM-DD" strings covered by the given blocked dates. A BlockedDate is stored as a calendar
 * day at UTC midnight, and the influencer's availability rules are keyed by a timezone (IST for every rule written now;
 * the blocked day is expressed in it too), so reading the stored value back in UTC recovers the right
 * "YYYY-MM-DD" to compare against generateSlots' rule-timezone day. Keeps the day-math pure and testable.
 */
export function blockedDaySet(dates: Date[]): Set<string> {
  const out = new Set<string>();
  for (const d of dates) {
    const iso = DateTime.fromJSDate(d, { zone: "utc" }).toISODate();
    if (iso) out.add(iso);
  }
  return out;
}

/** UTC bounds of the Indian Standard Time calendar day `date` ("YYYY-MM-DD"): 00:00 IST is 18:30 UTC the evening before. Null for a date that does not exist. */
export function dayBoundsUtc(date: string): { from: Date; to: Date } | null {
  const start = DateTime.fromISO(date, { zone: APP_TIME_ZONE }).startOf("day");
  if (!start.isValid) return null;
  return { from: start.toJSDate(), to: start.plus({ days: 1 }).toJSDate() };
}
