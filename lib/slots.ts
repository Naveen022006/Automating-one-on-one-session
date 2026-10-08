import { DateTime } from "luxon";

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
 * Rules are evaluated in their own timezone, so DST shifts are handled.
 */
export function generateSlots(
  rules: Rule[],
  durationMin: number,
  from: Date,
  to: Date,
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

export function isSlotStart(rules: Rule[], durationMin: number, start: Date): boolean {
  return generateSlots(rules, durationMin, start, new Date(start.getTime() + 1)).length === 1;
}

/** UTC bounds of calendar day `date` ("YYYY-MM-DD") as seen in timezone `tz`. */
export function dayBoundsUtc(date: string, tz: string): { from: Date; to: Date } | null {
  const start = DateTime.fromISO(date, { zone: tz }).startOf("day");
  if (!start.isValid) return null;
  return { from: start.toJSDate(), to: start.plus({ days: 1 }).toJSDate() };
}
