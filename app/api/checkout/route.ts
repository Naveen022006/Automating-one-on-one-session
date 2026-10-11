import { NextResponse } from "next/server";
import { ID_PATTERN, readJson } from "@/lib/http";
import { z } from "zod";
import { BookingNotFoundError, NotPayableError, startCheckout } from "@/lib/checkout";

const bodySchema = z.object({ bookingId: z.string().regex(ID_PATTERN) });

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  try {
    return NextResponse.json(await startCheckout(parsed.data.bookingId));
  } catch (e) {
    if (e instanceof BookingNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof NotPayableError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error("[checkout] failed", e);
    return NextResponse.json({ error: "Could not start payment" }, { status: 502 });
  }
}
