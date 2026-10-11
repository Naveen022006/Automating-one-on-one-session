import { listAudit, parsePage } from "@/lib/admin/data";

/**
 * The admin Audit log page's data, for GET /api/admin/audit. The caller has already passed the admin
 * gate (`requireAdminMfa()`).
 *
 * One page of `PAGE_SIZE` (25) entries per request, newest first, and the page number is bounded by `parsePage` (a whole
 * number below 10,000, else 1): there is no way to read the whole log in one call. The free-form `detail` column is never
 * sent; the page does not show it.
 */

export interface AdminAuditRow {
  id: string;
  createdAt: Date;
  adminEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
}

export interface AdminAuditView {
  page: number;
  pageCount: number;
  rows: AdminAuditRow[];
}

export async function loadAdminAuditView(params: { page?: string | null }): Promise<AdminAuditView> {
  const data = await listAudit(parsePage(params.page ?? undefined));
  return {
    page: data.page,
    pageCount: data.pageCount,
    rows: data.rows.map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      adminEmail: a.adminEmail,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      ip: a.ip,
    })),
  };
}
