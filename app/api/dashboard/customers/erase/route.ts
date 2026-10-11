import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireRecentAuth } from "@/lib/auth/session";
import { eraseCustomerData } from "@/lib/privacy";
import { jsonError, parseJson } from "@/lib/http";

const schema = z.object({ email: z.email().max(200) });

// Erases a customer's personal data on request (privacy). Irreversible, so it needs a recent password entry.
export async function POST(req: Request) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const result = await eraseCustomerData(auth.influencerId, parsed.data.email);
  if (result.found === 0) return jsonError("No bookings found for that email.", 404);
  // Counts only: the e-mail that was erased is personal data and must not be written back into a log.
  await recordActivity({ influencerId: auth.influencerId, action: "customers.erased", detail: { erased: result.erased, blocked: result.blocked }, req });
  if (result.blocked > 0) {
    return NextResponse.json({ ok: true, ...result, warning: `${result.blocked} upcoming booking(s) were kept. Cancel them first, then erase again.` });
  }
  return NextResponse.json({ ok: true, ...result });
}
