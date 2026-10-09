import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/admin/audit";
import { clearAdminCookie, getAdminAuth, revokeAdminSession } from "@/lib/admin/session";
import { clientIp } from "@/lib/rate-limit";

export async function POST(req: Request) {
  const admin = await getAdminAuth();
  if (admin) {
    await revokeAdminSession(admin.sessionId);
    await recordAudit({ adminId: admin.adminId, email: admin.email }, { action: "admin.logout", ip: clientIp(req.headers) }).catch(() => {});
  }
  return clearAdminCookie(NextResponse.json({ ok: true }));
}
