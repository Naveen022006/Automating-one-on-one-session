import { Prisma } from "@/generated/prisma/client";
import { ACTIVITY_ACTIONS, describeDevice, sanitiseActivityDetail, type ActivityAction, type ActivityDetail } from "@/lib/activity-actions";
import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/rate-limit/client-ip";
import { within } from "@/lib/timeout";

export { describeDevice };

/**
 * The influencer account activity log (doc/13-product-build-plan.md, WP-C): a security and dispute trail of what happened on an
 * account (sign-ins, failed sign-ins, password and payout-detail changes, refunds, price changes, customer erasures...), shown to
 * the influencer in Settings and to an administrator on the influencer's page.
 *
 * Best effort, by design: it is written AFTER the action succeeded, outside the action's transaction, and it NEVER throws and never
 * changes the outcome or the response of the action (the admin audit log keeps its stricter rule, lib/admin/audit.ts, because
 * administrators move money). A failed insert leaves one warning line in the log and is swallowed; a write that is slower than
 * ACTIVITY_WRITE_TIMEOUT_MS stops being waited for (the insert itself carries on in the background), so a saturated pool cannot slow
 * an action down. It uses the app's one pool: no extra connection.
 *
 * What goes in is limited by `ACTIVITY_DETAIL_KEYS` (lib/activity-actions.ts). Never a customer's name, e-mail or phone, a password,
 * a token or a full account number.
 */

/** How long a caller waits for the insert before carrying on. */
export const ACTIVITY_WRITE_TIMEOUT_MS = 2_000;

export interface ActivityInput {
  influencerId: string;
  action: ActivityAction;
  actor?: "influencer" | "system";
  targetType?: string;
  targetId?: string;
  detail?: ActivityDetail;
  /** The request that caused it: the client IP and the user agent are taken from its headers. Leave out for a system entry. */
  req?: Request;
}

type ActivityDb = { influencerActivity: Pick<typeof prisma.influencerActivity, "create"> };

/**
 * The one log line a failed write leaves (stderr is for real errors and the error webhook is for things somebody must act on; a missing
 * log entry is neither, so this is a warning without a webhook). The cause only: the last line of the database message, never the
 * input.
 */
function logFailure(error: unknown, action: string): void {
  const message = (error instanceof Error ? error.message : String(error)).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "unknown error";
  console.warn(JSON.stringify({ level: "warn", at: new Date().toISOString(), where: "activity-log", action, message: message.slice(0, 200) }));
}

/** Records one entry. Never throws. */
export async function recordActivity(input: ActivityInput, db: ActivityDb = prisma): Promise<void> {
  try {
    if (!Object.prototype.hasOwnProperty.call(ACTIVITY_ACTIONS, input.action)) throw new Error(`unknown activity action ${String(input.action)}`);
    const headers = input.req?.headers;
    const ip = headers ? clientIp(headers) : null;
    const userAgent = headers?.get("user-agent") ?? null;
    const detail = sanitiseActivityDetail(input.action, input.detail);
    await within(
      db.influencerActivity.create({
        data: {
          influencerId: input.influencerId,
          actor: input.actor ?? "influencer",
          action: input.action,
          targetType: input.targetType?.slice(0, 40),
          targetId: input.targetId?.slice(0, 64),
          detail: detail ?? Prisma.DbNull,
          ip: ip && ip !== "unknown" ? ip.slice(0, 64) : null,
          userAgent: userAgent ? userAgent.slice(0, 200) : null,
        },
        select: { id: true },
      }),
      ACTIVITY_WRITE_TIMEOUT_MS,
      "activity log write",
    );
  } catch (e) {
    try {
      logFailure(e, input.action);
    } catch {
      /* logging must never break the caller */
    }
  }
}

/**
 * Same as recordActivity for a place that only knows the sign-in (user) id: the influencer id is read first. Never throws.
 * Used by the few auth routes that have no AuthContext (registration, e-mail verification, password reset).
 */
export async function recordActivityForUser(userId: string, input: Omit<ActivityInput, "influencerId">, db = prisma): Promise<void> {
  try {
    const user = await within(db.user.findUnique({ where: { id: userId }, select: { influencerId: true } }), ACTIVITY_WRITE_TIMEOUT_MS, "activity log lookup");
    if (user) await recordActivity({ ...input, influencerId: user.influencerId });
  } catch (e) {
    logFailure(e, input.action);
  }
}

/**
 * A failed sign-in for an e-mail that has an account. Called WITHOUT await by POST /api/auth/login, after the same constant-time
 * password check an unknown e-mail goes through, so the response time never depends on whether the account exists. The lookup and
 * the insert happen in the background; an unknown e-mail records nothing. Never throws, never rejects.
 */
export function recordFailedLogin(email: string, req: Request): void {
  void (async () => {
    try {
      const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { influencerId: true } });
      if (user) await recordActivity({ influencerId: user.influencerId, action: "auth.login_failed", req });
    } catch (e) {
      logFailure(e, "auth.login_failed");
    }
  })();
}
