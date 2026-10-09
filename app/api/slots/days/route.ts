import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { daysWithSlots, loadBookableService, openSlots } from "@/lib/availability";
import { dayBoundsUtc, isValidTimezone } from "@/lib/slots";

export const dynamic = "force-dynamic";

const MAX_DAYS = 62;

// GET /api/slots/days?serviceId=...&from=YYYY-MM-DD&to=YYYY-MM-DD[&tz=Area/City]
// The days (in the customer's timezone) with at least one open slot, so the calendar can highlight them.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const serviceId = params.get("serviceId");
  const from = params.get("from");
  const to = params.get("to");
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (!serviceId || !from || !to || !DAY.test(from) || !DAY.test(to)) {
    return NextResponse.json({ error: "serviceId, from and to (YYYY-MM-DD) are required" }, { status: 400 });
  }
  const viewer = await getAuth().catch(() => null);
  const service = await loadBookableService(serviceId, viewer?.influencerId);
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });
  const tz = params.get("tz") ?? service.timezone;
  if (!isValidTimezone(tz)) return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });

  const start = dayBoundsUtc(from, tz);
  const end = dayBoundsUtc(to, tz);
  if (!start || !end || end.to <= start.from) return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  if (end.to.getTime() - start.from.getTime() > MAX_DAYS * 86_400_000) {
    return NextResponse.json({ error: `Ask for at most ${MAX_DAYS} days` }, { status: 400 });
  }
  const slots = await openSlots(service, start.from, end.to, new Date(), { ignoreWindow: viewer?.influencerId === service.influencerId });
  return NextResponse.json({ days: daysWithSlots(slots, tz) });
}
