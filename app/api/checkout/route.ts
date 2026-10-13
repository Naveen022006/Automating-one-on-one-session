import { NextResponse } from "next/server";
import { ID_PATTERN, readJson } from "@/lib/http";
import { z } from "zod";
import { BookingNotFoundError, NotPayableError, startCheckout } from "@/lib/checkout";
import { verifyBookingPollToken } from "@/lib/self-service";

// `token` is the booking's poll token (lib/self-service.ts), which only the browser that made the hold (or opened the pay link)
// holds. The booking id alone is a reference the customer may share with support; it must not start a payment, extend a hold or
// reveal the customer's name, email and phone (the checkout prefill).
const bodySchema = z.object({ bookingId: z.string().regex(ID_PATTERN), token: z.string().min(1).max(2000) });

function tokenMatches(bookingId: string, token: string): boolean {
  try {
    return verifyBookingPollToken(bookingId, token);
  } catch {
    return false; // APP_SECRET unset: nothing can be verified
  }
}

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  if (!tokenMatches(parsed.data.bookingId, parsed.data.token)) {
    return NextResponse.json({ error: "This payment page has expired. Reload the page and try again." }, { status: 403 });
  }

  try {
    return NextResponse.json(await startCheckout(parsed.data.bookingId));
  } catch (e) {
    if (e instanceof BookingNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof NotPayableError) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error("[checkout] failed", e);
    return NextResponse.json({ error: "Could not start payment" }, { status: 502 });
  }
}
