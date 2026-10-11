import { prisma } from "@/lib/db";

/** How long an activity row is kept. A constant on purpose (no setting): the log is a one-year trail. */
export const ACTIVITY_RETENTION_DAYS = 365;

/**
 * Deletes `influencer_activity_logs` rows older than ACTIVITY_RETENTION_DAYS and returns how many. Wired into `sweepExpiredAuthRows`
 * (lib/auth/sweep.ts), which the worker runs. No Next.js imports (the worker imports this).
 */
export async function sweepOldActivity(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.influencerActivity.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
