/**
 * STUB from the foundation branch (mk/00-foundation); owned by the activity log work package (doc/13-product-build-plan.md, WP-C).
 * It will delete `influencer_activity_logs` rows older than 365 days (`ACTIVITY_RETENTION_DAYS`). Already wired into
 * `sweepExpiredAuthRows` (lib/auth/sweep.ts), which the worker runs; the stub deletes nothing.
 */
export async function sweepOldActivity(now: Date = new Date()): Promise<number> {
  void now;
  return 0;
}
