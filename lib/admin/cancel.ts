import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { alertInfluencer } from "@/lib/alerts";
import { prisma } from "@/lib/db";
import { formatSessionTime } from "@/lib/format";
import { BookingNotManageableError, cancelBooking, type CancelResult } from "@/lib/manage";
import { reportError } from "@/lib/observability";
import { PLATFORM_CANCEL_MARK } from "@/lib/refunds";

/**
 * Cancels a booking on the platform's behalf (for example to unwind a suspended influencer's upcoming sessions). It reuses
 * `cancelBooking` with the influencer actor, so the existing code does everything else: the Calendar event, the reminders, the customer's
 * cancellation notice, and the refund decision (a full refund is due: the payment is flagged `needsRefund`, or refunded at once when
 * AUTO_REFUND_ON_CANCEL=true). The administrator then refunds a flagged payment from Payments.
 *
 * Allowed for a paid or scheduled booking whose session has not started, and for a FAILED one (what `cancelBooking` accepts). A session
 * that already took place is refused: there is nothing to cancel, refund the payment instead.
 */

export interface AdminCancelEligibilityInput {
  status: string;
  startTime: Date;
}

export type AdminCancelEligibility = { allowed: true } | { allowed: false; reason: string };

export function adminCancelEligibility(b: AdminCancelEligibilityInput, now: Date = new Date()): AdminCancelEligibility {
  if (b.status === "FAILED") return { allowed: true };
  if (b.status === "PAID" || b.status === "SCHEDULED") {
    return b.startTime.getTime() > now.getTime()
      ? { allowed: true }
      : { allowed: false, reason: "This session has already taken place; refund the payment instead." };
  }
  if (b.status === "COMPLETED") return { allowed: false, reason: "This session has already taken place; refund the payment instead." };
  if (b.status === "CANCELLED") return { allowed: false, reason: "This booking is already cancelled." };
  return { allowed: false, reason: "Only paid or scheduled bookings can be cancelled." };
}

export type AdminCancelResult =
  | { kind: "not-found" }
  | { kind: "not-allowed"; reason: string }
  | { kind: "ok"; refund: CancelResult["refund"]; warning: string | null };

export interface AdminCancelDeps {
  cancel: typeof cancelBooking;
  alert: typeof alertInfluencer;
  audit: typeof recordAudit;
}
const defaultDeps: AdminCancelDeps = { cancel: cancelBooking, alert: alertInfluencer, audit: recordAudit };

async function auditAfter(deps: AdminCancelDeps, admin: AuditActor, bookingId: string, action: string, ip: string | null, detail: Record<string, string | number | boolean | null>) {
  try {
    await deps.audit(admin, { action, targetType: "booking", targetId: bookingId, detail, ip });
  } catch (e) {
    reportError(e, { where: "adminCancelBooking", action, bookingId });
  }
}

export async function adminCancelBooking(
  bookingId: string,
  admin: AuditActor,
  reason: string,
  ip: string | null,
  overrides: Partial<AdminCancelDeps> = {},
  now: Date = new Date(),
): Promise<AdminCancelResult> {
  const deps = { ...defaultDeps, ...overrides };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      status: true,
      customerName: true,
      session: { select: { startTime: true, service: { select: { title: true, influencer: { select: { id: true, timezone: true } } } } } },
    },
  });
  if (!booking?.session?.service?.influencer) return { kind: "not-found" };
  const eligibility = adminCancelEligibility({ status: booking.status, startTime: booking.session.startTime }, now);
  if (!eligibility.allowed) return { kind: "not-allowed", reason: eligibility.reason };

  // Before anything is changed: if this write fails the error propagates (a 500) and the booking is untouched.
  await deps.audit(admin, { action: "booking.cancel_requested", targetType: "booking", targetId: bookingId, detail: { reason, status: booking.status }, ip });

  let result: CancelResult;
  try {
    result = await deps.cancel(bookingId, { actor: "influencer", byPlatform: true, reason: `${PLATFORM_CANCEL_MARK} ${reason}` });
  } catch (e) {
    if (e instanceof BookingNotManageableError) {
      // The booking changed between the read and the cancel (another administrator, the customer, the influencer).
      await auditAfter(deps, admin, bookingId, "booking.cancel_refused", ip, { reason: e.message.slice(0, 200) });
      return { kind: "not-allowed", reason: e.message };
    }
    await auditAfter(deps, admin, bookingId, "booking.cancel_error", ip, { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    throw e;
  }

  await auditAfter(deps, admin, bookingId, "booking.cancelled_by_admin", ip, { refund: result.refund.issued, refundDue: result.refund.eligible, warning: Boolean(result.warning) });

  const { service, startTime } = booking.session;
  const influencer = service.influencer;
  try {
    await deps.alert(influencer.id, {
      kind: "platform-cancelled",
      title: "A booking was cancelled by the platform",
      detail: `${booking.customerName}'s booking for ${service.title} (${formatSessionTime(startTime, influencer.timezone)}) was cancelled by the platform. Reason: ${reason}. The customer has been notified.${result.refund.eligible ? " The platform will refund the customer; you do not need to do anything." : ""}`,
      bookingId,
    });
  } catch (e) {
    reportError(e, { where: "adminCancelBooking", action: "alert", bookingId });
  }
  return { kind: "ok", refund: result.refund, warning: result.warning ?? null };
}
