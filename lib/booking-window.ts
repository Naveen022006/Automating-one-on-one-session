/**
 * How far ahead customers may book a service: not sooner than `minNoticeHours` from now, not later than
 * `maxAdvanceDays` days from now. Pure, so the slot list, the hold endpoint and the customer reschedule page all
 * apply the exact same rule. The influencer is never blocked by their own window when moving a booking.
 */

export const MAX_NOTICE_HOURS = 24 * 30;
export const MAX_ADVANCE_DAYS = 365;

export interface WindowRule {
  minNoticeHours: number;
  maxAdvanceDays: number;
}

export interface WindowBounds {
  /** First instant a booking may start. */
  earliest: Date;
  /** Last instant a booking may start. */
  latest: Date;
}

export function windowBounds(rule: WindowRule, now = new Date()): WindowBounds {
  return {
    earliest: new Date(now.getTime() + rule.minNoticeHours * 3_600_000),
    latest: new Date(now.getTime() + rule.maxAdvanceDays * 86_400_000),
  };
}

export function withinWindow(start: Date, rule: WindowRule, now = new Date()): boolean {
  const { earliest, latest } = windowBounds(rule, now);
  return start.getTime() >= earliest.getTime() && start.getTime() <= latest.getTime();
}

/** Why a start time is outside the window, in words a customer understands, or null when it is inside. */
export function windowProblem(start: Date, rule: WindowRule, now = new Date()): string | null {
  const { earliest, latest } = windowBounds(rule, now);
  if (start.getTime() < earliest.getTime()) {
    return rule.minNoticeHours >= 24 && rule.minNoticeHours % 24 === 0
      ? `This session needs at least ${rule.minNoticeHours / 24} day(s) notice.`
      : `This session needs at least ${rule.minNoticeHours} hour(s) notice.`;
  }
  if (start.getTime() > latest.getTime()) return `This session can be booked up to ${rule.maxAdvanceDays} days ahead.`;
  return null;
}
