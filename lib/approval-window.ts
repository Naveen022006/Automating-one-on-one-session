import { APPROVED_PAY_HOURS } from "@/lib/holds";

/**
 * How long the customer has to pay after a host approves a booking request, and the last moment an approval still leaves them enough time.
 * Pure and shared: lib/booking-approval.ts decides an approval with it, and the "request received" message says how long the host has to
 * answer with it, so the two can never disagree.
 */

/** Never pay later than this long before the session starts, so there is time to create the Meet link. */
export const MIN_LEAD_BEFORE_START_MS = 15 * 60_000;

/** Less than this to pay is not a real chance to pay: such a request cannot be approved any more. */
export const MIN_PAY_WINDOW_MS = 5 * 60_000;

/** The payment deadline after an approval: 24 hours, but never later than 15 minutes before the session. */
export function paymentDeadline(now: Date, sessionStart: Date): Date | null {
  const deadline = new Date(Math.min(now.getTime() + APPROVED_PAY_HOURS * 3_600_000, sessionStart.getTime() - MIN_LEAD_BEFORE_START_MS));
  return deadline.getTime() - now.getTime() >= MIN_PAY_WINDOW_MS ? deadline : null;
}

/**
 * The last moment a request for this session can still be approved (`paymentDeadline` is null after it). A request is held for up to
 * REQUEST_TTL_HOURS, but a host cannot answer "yes" after this, so it is also the end of the time the host has to answer.
 */
export function lastApprovalAt(sessionStart: Date): Date {
  return new Date(sessionStart.getTime() - MIN_LEAD_BEFORE_START_MS - MIN_PAY_WINDOW_MS);
}

/**
 * How many hours (fractions included, never negative) the host has left to approve this request: until the earlier of the request's hold
 * and the last moment an approval leaves time to pay.
 */
export function hoursToAnswer(holdExpiresAt: Date, sessionStart: Date, now: Date): number {
  const end = Math.min(holdExpiresAt.getTime(), lastApprovalAt(sessionStart).getTime());
  return Math.max(0, (end - now.getTime()) / 3_600_000);
}
