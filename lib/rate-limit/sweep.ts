import { prisma } from "@/lib/db";

/** Deletes expired Postgres rate-limit buckets. Called periodically by the worker (no Next.js imports here). */
export async function sweepExpiredBuckets(now = new Date()): Promise<number> {
  const { count } = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
