import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/session";
import { loadBookableService, openSlots } from "@/lib/availability";
import { isEntityId } from "@/lib/http";
import { normaliseTimeZoneInput } from "@/lib/india";
import { dayBoundsUtc } from "@/lib/slots";

export const dynamic = "force-dynamic";

// GET /api/slots?serviceId=...&date=YYYY-MM-DD[&tz=Area/City]
// `date` is an Indian Standard Time calendar day. `tz` is accepted for old clients and ignored (a name that is not a time zone is a 400).
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const serviceId = params.get("serviceId");
  const date = params.get("date");
  if (!isEntityId(serviceId) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // serviceId must look like an id before it reaches a query (a `%00` in it is refused by Postgres: a 500).
    return NextResponse.json({ error: "serviceId and date (YYYY-MM-DD) are required" }, { status: 400 });
  }

  const viewer = await getAuth().catch(() => null);
  const service = await loadBookableService(serviceId, viewer?.influencerId);
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  const tz = params.get("tz");
  const zone = tz === null ? null : normaliseTimeZoneInput(tz);
  if (zone && !zone.ok) return NextResponse.json({ error: zone.error }, { status: 400 });
  const bounds = dayBoundsUtc(date);
  if (!bounds) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  const owner = viewer?.influencerId === service.influencerId;
  return NextResponse.json({ slots: await openSlots(service, bounds.from, bounds.to, new Date(), { ignoreWindow: owner }) });
}
