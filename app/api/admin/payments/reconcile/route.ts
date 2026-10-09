import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/admin/audit";
import { requireAdminApi } from "@/lib/admin/session";
import { parseJson } from "@/lib/http";
import { reconcilePayments } from "@/lib/payouts";
import { clientIp } from "@/lib/rate-limit";

const schema = z.object({ paymentIds: z.array(z.string().min(1).max(40)).min(1).max(100) });

// Confirms each payment with Razorpay and marks it reconciled. Only reconciled payments can be paid out.
export async function POST(req: Request) {
  const admin = await requireAdminApi();
  if (admin instanceof NextResponse) return admin;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;

  const results = await reconcilePayments(parsed.data.paymentIds, admin.email);
  const ok = results.filter((r) => r.ok).length;
  await recordAudit(
    { adminId: admin.adminId, email: admin.email },
    {
      action: "payments.reconciled",
      targetType: "payment",
      detail: { requested: results.length, reconciled: ok, failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, reason: r.reason })) },
      ip: clientIp(req.headers),
    },
  );
  return NextResponse.json({ results, reconciled: ok, failed: results.length - ok });
}
