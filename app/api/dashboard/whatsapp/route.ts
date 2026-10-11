import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { jsonError, parseJson } from "@/lib/http";
import {
  WhatsAppConnectError,
  connectEmbedded,
  connectManual,
  disconnect,
  getConnectionView,
  refreshTemplates,
} from "@/lib/whatsapp-connection";

// The influencer's own WhatsApp number. Reads never include the access token. Connecting stores a credential, so it
// needs a recent password entry (the same rule as payout details); everything is verified with Meta before saving.

// The two-step verification PIN is optional: only for a number that already has a PIN of its own (or, when connecting
// by hand, one that is not registered yet). Embedded Signup otherwise registers the number with a PIN we generate.
const pin = z.string().trim().regex(/^\d{6}$/, "The two-step verification PIN is 6 digits.").optional();

// The messages are what an influencer reads under the field (components/app/WhatsAppConnect.tsx shows the first one), so they say what to
// enter, not what zod checked ("Too small: expected string to have >=5 characters").
const wabaId = z.string().trim().min(5, "Enter the WhatsApp Business Account ID from Meta (a long number).").max(40, "That account ID is too long. Copy it again from WhatsApp Manager.");
const phoneNumberId = z.string().trim().min(5, "Enter the Phone number ID from Meta (a long number).").max(40, "That phone number ID is too long. Copy it again from WhatsApp Manager.");

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect-manual"),
    wabaId,
    phoneNumberId,
    accessToken: z.string().trim().min(20, "Paste the permanent access token (a long string of letters and numbers).").max(1000, "That token is too long. Copy it again from Business settings."),
    pin,
  }),
  z.object({
    action: z.literal("connect-embedded"),
    code: z.string().trim().min(5, "WhatsApp did not send a sign-up code. Please try again.").max(2000),
    wabaId,
    phoneNumberId,
    pin,
    // The influencer's own choice, never assumed: the number has a PIN they do not have and we may replace it with ours.
    resetPin: z.boolean().optional(),
  }),
  z.object({ action: z.literal("refresh") }),
]);

export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ connection: await getConnectionView(auth.influencerId) });
}

export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const auth = body.action === "refresh" ? await requireApiAuth() : await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;

  try {
    if (body.action === "refresh") {
      const r = await refreshTemplates(auth.influencerId);
      return NextResponse.json({ connection: await getConnectionView(auth.influencerId), ...r });
    }
    const connection =
      body.action === "connect-manual"
        ? await connectManual(auth.influencerId, { wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, accessToken: body.accessToken, pin: body.pin })
        : await connectEmbedded(auth.influencerId, { code: body.code, wabaId: body.wabaId, phoneNumberId: body.phoneNumberId, pin: body.pin, resetPin: body.resetPin });
    // connection.notes: things worth telling the influencer that did not stop the connection (a token that could not be checked).
    return NextResponse.json({ connection });
  } catch (e) {
    if (e instanceof WhatsAppConnectError) return jsonError(e.message, e.status, { ...(e.field ? { field: e.field } : {}), ...(e.canReset ? { canReset: true } : {}) });
    throw e;
  }
}

export async function DELETE() {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  await disconnect(auth.influencerId);
  return NextResponse.json({ ok: true });
}
