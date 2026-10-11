import { NextResponse } from "next/server";
import { buildPortalExport, resolvePortalToken } from "@/lib/customer-portal";
import { jsonView } from "@/lib/views/http";

// "Download my data": everything stored about the address behind the link, as one JSON file (lib/customer-portal.ts buildPortalExport).
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const now = new Date();
  const access = await resolvePortalToken(token, now);
  if (!access) return jsonView({ state: "expired" }, { status: 403 });
  const data = await buildPortalExport(access.email, now);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-bookings-${now.toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
