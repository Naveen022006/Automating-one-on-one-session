import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { loadBookableService, openSlots } from "@/lib/availability";
import { dayBoundsUtc, isValidTimezone } from "@/lib/slots";

export const dynamic = "force-dynamic";

// GET /api/slots?serviceId=...&date=YYYY-MM-DD[&tz=Area/City]
// `date` is the calendar day in the customer's timezone `tz` (defaults to the influencer's).
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const serviceId = params.get("serviceId");
  const date = params.get("date");
  if (!serviceId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "serviceId and date (YYYY-MM-DD) are required" }, { status: 400 });
  }

  const viewer = await getAuth().catch(() => null);
  const service = await loadBookableService(serviceId, viewer?.influencerId);
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  const tz = params.get("tz") ?? service.timezone;
  if (!isValidTimezone(tz)) return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  const bounds = dayBoundsUtc(date, tz);
  if (!bounds) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  return NextResponse.json({ slots: await openSlots(service, bounds.from, bounds.to) });
}
