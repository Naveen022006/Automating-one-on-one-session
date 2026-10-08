import { prisma } from "@/lib/db";

/** Deletes expired sessions and expired single-use tokens. Called by the worker (no Next.js imports here). */
export async function sweepExpiredAuthRows(now = new Date()): Promise<number> {
  const [a, b, c] = await Promise.all([
    prisma.authSession.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return a.count + b.count + c.count;
}
