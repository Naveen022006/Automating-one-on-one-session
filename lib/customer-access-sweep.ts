/**
 * STUB from the foundation branch (mk/00-foundation); owned by the customer portal work package (doc/13-product-build-plan.md, WP-D).
 * It will delete expired `customer_access_tokens` rows. Already wired into `sweepExpiredAuthRows` (lib/auth/sweep.ts), which
 * the worker runs; the stub deletes nothing.
 */
export async function sweepExpiredCustomerAccess(now: Date = new Date()): Promise<number> {
  void now;
  return 0;
}
