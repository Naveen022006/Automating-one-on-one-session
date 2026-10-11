import { sweepOldActivity } from "@/lib/activity-retention";
import { sweepExpiredCustomerAccess } from "@/lib/customer-access-sweep";
import { prisma } from "@/lib/db";

/**
 * Deletes expired sessions and expired single-use tokens, plus the other time-bounded rows: influencer activity older than its
 * retention (lib/activity-retention.ts) and expired customer portal access tokens (lib/customer-access-sweep.ts).
 * Called by the worker (no Next.js imports here).
 */
export async function sweepExpiredAuthRows(now = new Date()): Promise<number> {
  const [a, b, c] = await Promise.all([
    prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  // Sequential on purpose (the database has 15 connections in total and the three deletes above already use three).
  const activity = await sweepOldActivity(now);
  const customerAccess = await sweepExpiredCustomerAccess(now);
  return a.count + b.count + c.count + activity + customerAccess;
}
