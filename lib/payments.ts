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

/** Razorpay answered with a non-2xx status. A 4xx (except 408/429) is a definite rejection; anything else is not. */
export class RazorpayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get definiteRejection(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  /** "pending" | "processed" | "failed" */
  status: string;
}

/**
 * Refunds a captured payment (all of it, or `amountMinor`). https://razorpay.com/docs/api/refunds/create-normal/
 * The final outcome arrives later as a `refund.processed` / `refund.failed` webhook.
 */
export async function createRefund(
  input: { providerPaymentId: string; amountMinor?: number; receipt?: string; notes?: Record<string, string> },
  fetchFn: typeof fetch = fetch,
): Promise<RazorpayRefund> {
  const auth = Buffer.from(`${razorpayKeyId()}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const res = await fetchFn(`${RAZORPAY_API}/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(input.amountMinor !== undefined ? { amount: input.amountMinor } : {}),
      speed: "normal",
      ...(input.receipt ? { receipt: input.receipt.slice(0, 40) } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RazorpayHttpError(res.status, `Razorpay refund failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as RazorpayRefund;
}

/** All refunds of a payment, used to reconcile a refund call whose outcome was not confirmed (timeout, 5xx). */
export async function listRefunds(providerPaymentId: string, fetchFn: typeof fetch = fetch): Promise<RazorpayRefund[]> {
  const auth = Buffer.from(`${razorpayKeyId()}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const res = await fetchFn(`${RAZORPAY_API}/payments/${encodeURIComponent(providerPaymentId)}/refunds?count=100`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RazorpayHttpError(res.status, `Razorpay refund lookup failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { items?: RazorpayRefund[] };
  return data.items ?? [];
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
