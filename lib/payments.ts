import { createHmac, timingSafeEqual } from "node:crypto";

const RAZORPAY_API = "https://api.razorpay.com/v1";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export const razorpayKeyId = () => env("RAZORPAY_KEY_ID");

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

/** Creates a Razorpay order. `amountMinor` is paise for INR. */
export async function createOrder(input: {
  amountMinor: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  const auth = Buffer.from(`${razorpayKeyId()}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const res = await fetch(`${RAZORPAY_API}/orders`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Razorpay order creation failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as RazorpayOrder;
}

/** Verifies the `x-razorpay-signature` header (HMAC-SHA256 hex of the exact raw body), in constant time. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret = env("RAZORPAY_WEBHOOK_SECRET"),
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
