import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isVerifyRequestValid, parseWhatsAppStatuses } from "@/lib/whatsapp-webhook";

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
  const raw = await req.text();
  try {
    const payload = JSON.parse(raw);
    const updates = parseWhatsAppStatuses(payload);
    for (const u of updates) {
      // No-op when the provider id is unknown (e.g. an inbound message we never recorded).
      await prisma.message.updateMany({
        where: { providerMessageId: u.providerMessageId },
        data: { status: u.status, error: u.error },
      });
    }
    return NextResponse.json({ ok: true, applied: updates.length });
  } catch (e) {
    console.error("[whatsapp-webhook] failed", e);
    // Non-2xx asks Meta to retry; a malformed/unexpected payload is worth retrying.
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
