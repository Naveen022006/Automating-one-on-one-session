import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { parseJson } from "@/lib/http";
import { cancelLink, disconnectLink, getWhatsAppWebView, requestLink, type CommandResult } from "@/lib/whatsapp-web/commands";
import { prisma } from "@/lib/db";
import { maskE164 } from "@/lib/whatsapp-web/mask";
import { requestTestSend } from "@/lib/whatsapp-web/test-send";
import type { WhatsAppWebErrorBody, WhatsAppWebTestAnswer } from "@/lib/whatsapp-web/api-types";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * The optional "link my WhatsApp by QR code" mode, influencer side (doc/14-whatsapp-qr-*.md). The influencer is always the signed-in
 * one: nothing in the URL or the body names an influencer.
 *
 *   GET   the WhatsAppWebView (status, masked number, limits, the risk statement; the QR picture only while waiting for a scan).
 *   POST  { action: "start", consent: true, consentVersion }  asks the worker to link (records the consent with its version)
 *         { action: "cancel" }      gives up a link nobody has scanned yet
 *         { action: "disconnect" }  unlinks and deletes the stored login (always allowed)
 *         { action: "test" }        sends ONE test message to the linked number itself, at most one a minute
 *         Each answers with the fresh view (the test answer adds `test`). Refusals are `{ error, code }`.
 *
 * Starting needs a recent password entry like connecting the official number does: a stolen session must not be able to attach its own
 * phone to somebody else's customers. The Origin check and the rate limits are the proxy's (lib/rate-limit/policies.ts).
 */

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), consent: z.boolean(), consentVersion: z.string().max(100) }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("disconnect") }),
  z.object({ action: z.literal("test") }),
]);

const refusal = (status: number, body: WhatsAppWebErrorBody, headers?: Record<string, string>) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", ...headers } });

function commandRefusal(r: Extract<CommandResult, { ok: false }>): NextResponse {
  return refusal(r.code === "consent-required" ? 400 : 409, { error: r.message, code: r.code });
}

export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await getWhatsAppWebView(auth.influencerId));
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  // The identity comes first: an unauthenticated caller learns nothing about the body rules.
  const auth = !parsed.ok || parsed.data.action !== "start" ? await requireApiAuth() : await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const influencerId = auth.influencerId;

  if (body.action === "start") {
    const before = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true } });
    const alreadyUnderWay = Boolean(before?.wantLinked && (before.status === "PENDING_QR" || before.status === "LINKED" || before.status === "RECONNECTING"));
    const result = await requestLink(influencerId, { consent: body.consent, consentVersion: body.consentVersion });
    if (!result.ok) return commandRefusal(result);
    if (!alreadyUnderWay) await recordActivity({ influencerId, action: "whatsapp_web.consent", detail: { version: body.consentVersion }, req });
    return jsonView(await getWhatsAppWebView(influencerId));
  }

  if (body.action === "cancel") {
    const result = await cancelLink(influencerId);
    if (!result.ok) return commandRefusal(result);
    return jsonView(await getWhatsAppWebView(influencerId));
  }

  if (body.action === "disconnect") {
    const before = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { status: true, wantLinked: true, phoneE164: true } });
    const hadSomething = Boolean(before && (before.wantLinked || before.status !== "NOT_LINKED"));
    await disconnectLink(influencerId);
    if (hadSomething) await recordActivity({ influencerId, action: "whatsapp_web.disconnected", detail: { phone: maskE164(before?.phoneE164), reason: "influencer" }, req });
    return jsonView(await getWhatsAppWebView(influencerId));
  }

  const sent = await requestTestSend(influencerId);
  if (!sent.ok) {
    if (sent.code === "cooldown") return refusal(429, { error: sent.message, code: "cooldown", retryAfterSec: sent.retryAfterSec }, { "Retry-After": String(sent.retryAfterSec ?? 60) });
    return refusal(sent.code === "unavailable" ? 503 : 409, { error: sent.message, code: sent.code });
  }
  const answer: WhatsAppWebTestAnswer = {
    ...(await getWhatsAppWebView(influencerId)),
    test: { state: sent.outcome.state, message: sent.outcome.state === "failed" ? sent.outcome.message : null },
  };
  return jsonView(answer);
}
