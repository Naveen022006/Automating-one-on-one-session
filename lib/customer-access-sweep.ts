import { prisma } from "@/lib/db";

/**
 * Deletes expired customer portal access tokens (`customer_access_tokens`, valid for one hour). Wired into `sweepExpiredAuthRows`
 * (lib/auth/sweep.ts), which the worker runs. An expired row is already refused by `resolvePortalToken`; this only keeps the table small.
 */
export async function sweepExpiredCustomerAccess(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.customerAccessToken.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
