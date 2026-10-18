/**
 * How long a booking message stays worth sending when it waits in a linked number's queue. Pure.
 *
 *  - reminder-15m: until the session starts ("starts in 15 minutes" is wrong afterwards);
 *  - reminder-24h: until less than 12 hours are left (its text says "tomorrow"; the same rule as staleReminderReason in lib/reminders.ts);
 *  - confirmation, reschedule, cancellation, request received: 30 minutes after they were handed to the queue;
 *  - request accepted (it carries the payment link): until the time to pay ends;
 *  - request declined, request expired: 6 hours after they were handed to the queue.
 *
 * A message that passes its deadline while it waits is dropped by the queue, immediately before the send would have happened.
 */

/** The 24-hour template says "tomorrow", so it is not sent once less than this is left. (lib/reminders.ts re-exports it.) */
export const REMINDER_24H_MIN_LEAD_MS = 12 * 60 * 60 * 1_000;
/** How long a confirmation, a reschedule notice, a cancellation notice or a "request received" notice may wait in the queue. */
export const NOTICE_MAX_QUEUE_MS = 30 * 60_000;
/** How long a "request declined" or "request expired" notice may wait in the queue. */
export const REQUEST_NOTICE_MAX_QUEUE_MS = 6 * 60 * 60_000;

export function isReminderTemplate(template: string): boolean {
  return template === "reminder-24h" || template === "reminder-15m";
}

/**
 * `payByMs` is the end of the booking's hold; only the "request accepted" notice reads it (a payment link is worthless after the time
 * to pay has gone). Without it that notice gets the ordinary 30 minutes.
 */
export function webSendDeadline(template: string, sessionStartMs: number, nowMs: number, payByMs?: number): number {
  if (template === "reminder-15m") return sessionStartMs;
  if (template === "reminder-24h") return sessionStartMs - REMINDER_24H_MIN_LEAD_MS;
  if (template === "request-approved" && payByMs !== undefined) return payByMs;
  if (template === "request-declined" || template === "request-expired") return nowMs + REQUEST_NOTICE_MAX_QUEUE_MS;
  return nowMs + NOTICE_MAX_QUEUE_MS;
}
