import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  isVerifyRequestValid,
  parseWhatsAppStatuses,
  verifyMetaSignature,
} from "@/lib/whatsapp-webhook";

// Meta's verification handshake: echo hub.challenge back as plain text when the verify token matches.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (isVerifyRequestValid(mode, token, process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)) {
    return new Response(challenge ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

// Delivery-status callbacks: advance the matching Message row by providerMessageId. Return 200 even
// when nothing matched so Meta does not retry a callback we have already processed (mirrors the
// payment webhook's raw-body-first + try/catch shape).
export async function POST(req: Request) {
  // The X-Hub-Signature-256 header covers the exact bytes Meta sent, so read the body as text and
  // verify before trusting anything. Without this, anyone who can reach the endpoint and guess a
  // providerMessageId could flip a message's status (e.g. to FAILED), mirroring the payment webhook.
  const raw = await req.text();
  if (
    !verifyMetaSignature(
      raw,
      req.headers.get("x-hub-signature-256"),
      process.env.WHATSAPP_APP_SECRET,
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  try {
    const payload = JSON.parse(raw);
    const updates = parseWhatsAppStatuses(payload);
    for (const u of updates) {
      // Only overwrite the error column on FAILED transitions (u.error is present). On other
      // transitions we leave the stored error intact so a later DELIVERED/READ callback does not
      // wipe diagnostic context from a prior FAILED callback.
      const data =
        "error" in u ? { status: u.status, error: u.error } : { status: u.status };
      // No-op when the provider id is unknown (e.g. an inbound message we never recorded).
      await prisma.message.updateMany({
        where: { providerMessageId: u.providerMessageId },
        data,
      });
    }
    return NextResponse.json({ ok: true, applied: updates.length });
  } catch (e) {
    console.error("[whatsapp-webhook] failed", e);
    // Non-2xx asks Meta to retry; a malformed/unexpected payload is worth retrying.
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
