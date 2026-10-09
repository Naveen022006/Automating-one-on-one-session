import assert from "node:assert/strict";
import { test } from "node:test";
import { bookingEmail, passwordResetMessage } from "../lib/email/templates";
import { escapeHtml } from "../lib/email/layout";
import { customerZone, formatSessionTime } from "../lib/format";
import { buildIcs } from "../lib/ics";
import { cleanParam, smsBody, templateParams, whatsappComponents } from "../lib/message-templates";
import { refundDecision } from "../lib/refund-policy";
import { csvCell, toCsv } from "../lib/dashboard";

const ctx = {
  link: "https://meet.google.com/abc-defg-hij",
  serviceTitle: "1:1 Career Call",
  influencerName: "Demo Creator",
  when: formatSessionTime(new Date("2026-10-12T05:30:00Z"), "Asia/Kolkata", "en-IN"),
};

test("session times are shown in the customer's timezone, never as ISO", () => {
  assert.match(ctx.when, /12 Oct,? 2026/);
  assert.match(ctx.when, /11:00/);
  assert.doesNotMatch(ctx.when, /T05:30|Z$/);
  assert.equal(customerZone(null, "Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(customerZone("Not/AZone", "Europe/London"), "Europe/London");
});

test("WhatsApp templates get link, service, host and time, in a fixed order", () => {
  assert.deepEqual(templateParams("booking-confirmation", ctx), [ctx.link, ctx.serviceTitle, ctx.influencerName, ctx.when]);
  assert.deepEqual(templateParams("cancellation", ctx), [ctx.serviceTitle, ctx.influencerName, ctx.when]);
  const [body] = whatsappComponents("reminder-15m", ctx);
  assert.equal(body.type, "body");
  assert.equal(body.parameters.length, 4);
  assert.equal(templateParams("reschedule", { ...ctx, link: null })[0], "(link coming soon)");
});

test("parameters are cleaned for WhatsApp (no newlines, never empty)", () => {
  assert.equal(cleanParam("a\nb\tc"), "a b c");
  assert.equal(cleanParam("   "), "-");
  assert.equal(cleanParam("x      y"), "x   y");
});

test("SMS fallback carries the same readable content", () => {
  const sms = smsBody("booking-confirmation", ctx);
  assert.match(sms, /1:1 Career Call/);
  assert.match(sms, /Demo Creator/);
  assert.match(sms, /meet\.google\.com/);
  assert.ok(sms.includes(ctx.when));
});

test("booking emails have html + text, escape user content, and include the manage link", () => {
  const email = bookingEmail("booking-confirmation", {
    customerName: "<script>alert(1)</script> Ana",
    serviceTitle: "Call & <b>chat</b>",
    influencerName: "Demo Creator",
    durationMin: 30,
    startTime: new Date("2026-10-12T05:30:00Z"),
    tz: "Asia/Kolkata",
    meetLink: ctx.link,
    manageUrl: "https://app.example.com/manage/tok",
    icsUrl: "https://app.example.com/api/bookings/b1/ics",
    payment: { amountMinor: 49900, currency: "INR", reference: "pay_123" },
  });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;b&gt;chat&lt;\/b&gt;/);
  assert.match(email.html, /https:\/\/app\.example\.com\/manage\/tok/);
  assert.match(email.text, /Reschedule or cancel: https:\/\/app\.example\.com\/manage\/tok/);
  assert.match(email.text, /pay_123/);
  assert.match(email.subject, /Confirmed/);
  const cancelled = bookingEmail("booking-cancelled", {
    customerName: "Ana",
    serviceTitle: "Call",
    influencerName: "Host",
    durationMin: 30,
    startTime: new Date(),
    tz: "UTC",
    meetLink: null,
    manageUrl: null,
    icsUrl: null,
    payment: null,
    refundNote: "You will be refunded in full.",
  });
  assert.match(cancelled.text, /refunded in full/);
  assert.equal(escapeHtml(`"'<>&`), "&quot;&#39;&lt;&gt;&amp;");
});

test("non-http links are never rendered into emails", () => {
  const m = passwordResetMessage("Ana", "javascript:alert(1)");
  assert.doesNotMatch(m.html, /javascript:/);
});

test("refund policy decisions", () => {
  const start = new Date("2030-01-10T10:00:00Z");
  const early = new Date("2030-01-08T10:00:00Z");
  const late = new Date("2030-01-10T02:00:00Z");
  assert.equal(refundDecision({ policy: "NONE", actor: "influencer", sessionStart: start, now: late }).refund, true, "host cancel always refunds");
  assert.equal(refundDecision({ policy: "FULL", actor: "customer", sessionStart: start, now: late }).refund, true);
  assert.equal(refundDecision({ policy: "NONE", actor: "customer", sessionStart: start, now: early }).refund, false);
  assert.equal(refundDecision({ policy: "NOTICE_24H", actor: "customer", sessionStart: start, now: early }).refund, true);
  assert.equal(refundDecision({ policy: "NOTICE_24H", actor: "customer", sessionStart: start, now: late }).refund, false);
});

test("calendar file is valid RFC 5545 with escaped text", () => {
  const ics = buildIcs({
    uid: "b1@test",
    title: "Call, with; Host",
    description: "Line 1\nLine 2",
    start: new Date("2026-10-12T05:30:00Z"),
    end: new Date("2026-10-12T06:00:00Z"),
    url: ctx.link,
    now: new Date("2026-10-01T00:00:00Z"),
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261012T053000Z\r\n/);
  assert.match(ics, /SUMMARY:Call\\, with\\; Host/);
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
});

test("CSV export cells are escaped and formula-safe", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell(-5), "-5");
  assert.equal(toCsv([["a", 1], [null, "x"]]), "a,1\r\n,x\r\n");
});
