import { paymentViewCounts } from "@/lib/admin/data";
import type { AdminContext } from "@/lib/admin/session";
import { getHealthReport } from "@/lib/health";

/**
 * Everything the admin console frame needs (sidebar badges and the account menu). Served by
 * GET /api/admin/shell. The caller has already passed the
 * admin gate (`requireAdminMfa({ allowEnrollment: true })`).
 */
export interface AdminShellView {
  admin: { name: string; email: string };
  /** Payments needing a refund or showing a mismatch (badge on Payments). */
  attentionCount: number;
  /** Unhealthy conditions (badge on System health). 0 when the health report itself cannot be built. */
  healthCount: number;
}

export async function loadAdminShell(admin: Pick<AdminContext, "name" | "email">): Promise<AdminShellView> {
  const [counts, health] = await Promise.all([paymentViewCounts(), getHealthReport().catch(() => null)]);
  return {
    admin: { name: admin.name, email: admin.email },
    attentionCount: counts.needsRefund + counts.mismatch,
    healthCount: health?.unhealthy.length ?? 0,
  };
}
