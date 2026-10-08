import { NextResponse } from "next/server";
import { handleRazorpayEvent, type RazorpayWebhook } from "@/lib/payment-webhook";
import { verifyWebhookSignature } from "@/lib/payments";

export async function POST(req: Request) {
  // The signature covers the exact bytes Razorpay sent, so read the body as text before parsing.
  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventId = req.headers.get("x-razorpay-event-id");
  if (!eventId) return NextResponse.json({ error: "Missing event id" }, { status: 400 });

  let event: RazorpayWebhook;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const outcome = await handleRazorpayEvent(eventId, event);
    return NextResponse.json({ ok: true, outcome });
  } catch (e) {
    // Non-2xx makes Razorpay retry; the event was not recorded as seen because the transaction rolled back.
    console.error("[webhook] failed", eventId, e);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
