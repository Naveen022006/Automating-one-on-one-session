import assert from "node:assert/strict";
import { test } from "node:test";
import { postmarkTransport, resendTransport } from "../lib/email/providers";
import { sendViaMsg91, sendViaTwilio } from "../lib/sms";
import { createRefund } from "../lib/payments";

// Provider integrations with an injected fetch: request shape and response handling, no network.

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const old: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      old[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(old)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

test(
  "MSG91 flow: authkey header, template per message type, variables, request id",
  withEnv({ SMS_API_KEY: "auth-1", MSG91_TEMPLATE_BOOKING_CONFIRMATION: "flow-confirm", MSG91_TEMPLATE_DEFAULT: "flow-default" }, async () => {
    const calls: Call[] = [];
    const r = await sendViaMsg91(
      { to: "+919876543210", body: "hello", template: "booking-confirmation", variables: ["a", "b"] },
      "+919876543210",
      fakeFetch(200, { type: "success", message: "req-42" }, calls),
    );
    assert.equal(r.providerMessageId, "req-42");
    assert.equal(calls[0].url, "https://control.msg91.com/api/v5/flow");
    assert.equal((calls[0].init.headers as Record<string, string>).authkey, "auth-1");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.template_id, "flow-confirm");
    assert.deepEqual(body.recipients[0], { mobiles: "919876543210", body: "hello", var1: "a", var2: "b" });

    await assert.rejects(
      sendViaMsg91({ to: "+91", body: "x", template: "reschedule" }, "+91", fakeFetch(200, { type: "error", message: "bad template" }, [])),
      /bad template/,
    );
  }),
);

test(
  "Twilio: basic auth, form body, messaging service, returns sid",
  withEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_MESSAGING_SERVICE_SID: "MG1" }, async () => {
    const calls: Call[] = [];
    const r = await sendViaTwilio({ to: "+15551234567", body: "hi" }, "+15551234567", fakeFetch(201, { sid: "SM9" }, calls));
    assert.equal(r.providerMessageId, "SM9");
    assert.match(calls[0].url, /Accounts\/AC1\/Messages\.json$/);
    const form = new URLSearchParams(String(calls[0].init.body));
    assert.equal(form.get("MessagingServiceSid"), "MG1");
    assert.equal(form.get("To"), "+15551234567");
    await assert.rejects(sendViaTwilio({ to: "+1", body: "x" }, "+1", fakeFetch(400, "nope", [])), /Twilio SMS send failed \(400\)/);
  }),
);

test(
  "Resend and Postmark: html + text bodies, sender, error on non-2xx",
  withEnv({ RESEND_API_KEY: "re_1", POSTMARK_SERVER_TOKEN: "pm_1", EMAIL_FROM: "Bookings <b@example.com>" }, async () => {
    const email = { to: { email: "a@example.com", name: 'Ana "A"' }, subject: "S", html: "<p>H</p>", text: "T", tag: "booking-confirmation" };
    const calls: Call[] = [];
    const r1 = await resendTransport(fakeFetch(200, { id: "e1" }, calls))(email);
    assert.equal(r1.providerMessageId, "e1");
    const rb = JSON.parse(String(calls[0].init.body));
    assert.equal(rb.from, "Bookings <b@example.com>");
    assert.deepEqual(rb.to, ['"Ana A" <a@example.com>']);
    assert.equal(rb.text, "T");
    const r2 = await postmarkTransport(fakeFetch(200, { MessageID: "p1" }, calls))(email);
    assert.equal(r2.providerMessageId, "p1");
    assert.equal(JSON.parse(String(calls[1].init.body)).TextBody, "T");
    await assert.rejects(resendTransport(fakeFetch(422, "invalid", []))(email), /Resend send failed \(422\)/);
  }),
);

test(
  "Razorpay refund: payment endpoint, amount, receipt",
  withEnv({ RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "s" }, async () => {
    const calls: Call[] = [];
    const refund = await createRefund(
      { providerPaymentId: "pay_1", amountMinor: 10000, receipt: "refund_x" },
      fakeFetch(200, { id: "rfnd_1", payment_id: "pay_1", amount: 10000, currency: "INR", status: "processed" }, calls),
    );
    assert.equal(refund.id, "rfnd_1");
    assert.equal(calls[0].url, "https://api.razorpay.com/v1/payments/pay_1/refund");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { amount: 10000, speed: "normal", receipt: "refund_x" });
  }),
);
