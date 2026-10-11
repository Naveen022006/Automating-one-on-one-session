// WP-B B1: GET /api/admin/exports/:kind (payments | bookings | payouts | audit), the CSV exports of the admin console.
//
// The pure part (date range rules, file names, the cap constants, formula neutralising) needs no database. The database part (needs
// DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise) calls the real route handler with only `next/headers` replaced and
// pins: the gate (401, 403 enroll, 403 verify, ok), 404 for an unknown kind, 400 for a bad range, the cap, each kind's header row exactly,
// that an erased customer shows "(erased)" and no e-mail, that a cell starting with = + - @ is neutralised, that nothing secret leaves
// (phone, Meet link, intake answers, ids of events, bank details, free-form audit detail), the `admin.export` audit row with the row
// count, and the download headers. The rows of the run sit on one quiet day far in the future so other people's data never mixes in.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { toCsv } from "../lib/dashboard";
import { prisma } from "../lib/db";
import { matchRouteRule } from "../lib/rate-limit/policies";
import {
  ADMIN_EXPORT_MAX_DAYS,
  ADMIN_EXPORT_ROW_CAP,
  EXPORT_KINDS,
  ExportTooLargeError,
  exportFilename,
  isExportKind,
  parseExportRange,
} from "../lib/admin/exports";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const emailX = `exp-x-${run}@example.com`; // administrator with two-factor
const emailY = `exp-y-${run}@example.com`; // administrator without
const auditEmail = `exp-audit-${run}@example.com`;
const slug = `exp-${run}`;
const DAY = 86_400_000;

// A day in 2060 or later that nobody else writes rows on (the range limit is 2100-12-31).
const n = Number(run.slice(-6));
const quiet = new Date(Date.UTC(2060 + (n % 35), n % 12, 1 + (n % 27)));
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const FROM = dayOf(quiet);
const at = (offsetMs: number) => new Date(quiet.getTime() + offsetMs);

const keys = (o: unknown) => Object.keys(o as object).sort();
const jar = new Map<string, string>();
type Handler = (req: Request, ctx: { params: Promise<{ kind: string }> }) => Promise<Response>;
let GET: Handler;
let sessionLib: typeof import("../lib/admin/session");
let exportsLib: typeof import("../lib/admin/exports");
let X = "";
let Y = "";
let influencerId = "";
const savedEnv: Record<string, string | undefined> = {};
const ENV_NAMES = ["RATE_LIMIT_STORE", "REDIS_URL", "ADMIN_REQUIRE_2FA"];
const hidden: string[] = [];
const secret = (label: string) => {
  const value = `hidden-${label}-${run}`;
  hidden.push(value);
  return value;
};
/** Replaces the export's row cap from inside the test (the route calls buildExport without one). */
let capOverride: number | undefined;

/** A minimal RFC 4180 reader: rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  assert.equal(quoted, false, "no unterminated quote");
  assert.equal(cell, "", "the file ends with a line break");
  assert.equal(row.length, 0);
  return rows;
}

async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

async function ask(kind: string, query: string, cookie?: string) {
  jar.clear();
  if (cookie !== undefined) jar.set(sessionLib.adminCookieName(), cookie);
  const res = await GET(new Request(`http://localhost/api/admin/exports/${kind}${query}`), { params: Promise.resolve({ kind }) });
  return res;
}
const range = (from = FROM, to = FROM) => `?from=${from}&to=${to}`;

/* ---------- pure rules ---------- */

test("the cap and the longest range are what the plan says; the kinds are the four exports", () => {
  assert.equal(ADMIN_EXPORT_ROW_CAP, 20_000);
  assert.equal(ADMIN_EXPORT_MAX_DAYS, 366);
  assert.deepEqual([...EXPORT_KINDS], ["payments", "bookings", "payouts", "audit"]);
  for (const k of EXPORT_KINDS) assert.ok(isExportKind(k));
  for (const odd of ["", "payment", "PAYMENTS", "../audit", "__proto__", "audit.csv", "constructor", "toString"]) assert.equal(isExportKind(odd), false, odd);
  assert.equal(new ExportTooLargeError(ADMIN_EXPORT_ROW_CAP).message, "More than 20,000 rows. Choose a shorter range.");
  assert.equal(exportFilename("payments", { from: "2026-10-01", to: "2026-10-11" }), "payments-2026-10-01-to-2026-10-11.csv");
});

test("parseExportRange: defaults to the 1st of the month up to today, `to` is inclusive, bad or too long ranges are refused", () => {
  const now = new Date("2026-10-11T08:00:00Z");
  const ok = (qs: string) => {
    const r = parseExportRange(new URLSearchParams(qs), now);
    assert.ok(r.ok, qs);
    return r.range;
  };
  const bad = (qs: string) => {
    const r = parseExportRange(new URLSearchParams(qs), now);
    assert.ok(!r.ok, qs);
    return r.error;
  };
  const dflt = ok("");
  assert.deepEqual([dflt.from, dflt.to], ["2026-10-01", "2026-10-11"]);
  assert.equal(dflt.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(dflt.end.toISOString(), "2026-10-12T00:00:00.000Z", "to is inclusive: the bound is the start of the next day");
  assert.deepEqual([ok("from=2026-09-15").from, ok("from=2026-09-15").to], ["2026-09-15", "2026-10-11"]);
  assert.equal(ok("to=2026-08-20").from, "2026-08-01", "only `to`: the 1st of its month");
  assert.equal(ok("from=2026-10-05&to=2026-10-05").end.toISOString(), "2026-10-06T00:00:00.000Z", "one day");
  assert.ok(ok("from=2025-10-11&to=2026-10-11"), "366 days is allowed");
  assert.match(bad("from=2025-10-10&to=2026-10-11"), /at most 366 days/);
  assert.match(bad("from=2026-10-12&to=2026-10-11"), /after the end/);
  for (const odd of ["2026-02-31", "2026-13-01", "26-10-01", "2026/10/01", "abc", "0000-01-01", "9999-12-31", "2026-10-01T00:00:00Z", "2026-1-1"]) {
    assert.match(bad(`from=${encodeURIComponent(odd)}&to=2026-10-11`), /start date/, odd);
    assert.match(bad(`from=2026-10-01&to=${encodeURIComponent(odd)}`), /end date/, odd);
  }
});

test("toCsv neutralises a cell that starts with = + - @ tab or CR, and quotes commas, quotes and line breaks", () => {
  const csv = toCsv([["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tx", "\rx", 'say "hi", ok', "fine", "a\nb", null, 5]]);
  assert.equal(csv, `'=1+1,'+SUM(A1),'-2+3,'@cmd,'\tx,"'\rx","say ""hi"", ok",fine,"a\nb",,5\r\n`);
});

test("toCsv also neutralises a leading line feed and the full-width = + - @ (U+FF1D, U+FF0B, U+FF0D, U+FF20); numbers are left alone", () => {
  const csv = toCsv([["\n=1+1", "＝SUM(1)", "＋1", "－1", "＠x", "a=b", "-5", -5, "x＝"]]);
  assert.equal(csv, `"'\n=1+1",'＝SUM(1),'＋1,'－1,'＠x,a=b,'-5,-5,x＝\r\n`);
});

test("the export endpoints share one tight rate rule (GET and HEAD), ahead of the generic admin one", () => {
  for (const kind of EXPORT_KINDS) {
    for (const method of ["GET", "HEAD"]) {
      const rule = matchRouteRule(method, `/api/admin/exports/${kind}`);
      assert.equal(rule?.name, "admin-export", `${method} ${kind}`);
      assert.equal(rule?.limit, 30);
    }
  }
  assert.equal(matchRouteRule("GET", "/api/admin/exports/other")?.name, "admin", "an unknown kind falls under the generic rule");
});

/* ---------- database part ---------- */

async function seed() {
  const influencer = await prisma.influencer.create({ data: { slug, name: `+Export Owner ${run}`, email: `exp-owner-${run}@example.com` } });
  influencerId = influencer.id;
  const service = await prisma.service.create({ data: { influencerId, title: `@Export call ${run}`, durationMin: 30, priceMinor: 105000 } });
  let n2 = 0;
  const booking = async (kind: string, createdAt: Date, extra: Record<string, unknown> = {}) => {
    const start = new Date(quiet.getTime() + (10 + n2++) * 60_000 + 30 * DAY);
    const session = await prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), meetLink: null } });
    return prisma.booking.create({
      data: {
        sessionId: session.id,
        status: "SCHEDULED",
        createdAt,
        customerName: `Export ${kind} ${run}`,
        customerEmail: `export-${kind}-${run}@example.com`,
        whatsappE164: `+91${secret(`phone-${kind}`)}`,
        meetLink: `https://meet.google.com/${secret(`meet-${kind}`)}`,
        eventId: secret(`event-${kind}`),
        lastError: secret(`error-${kind}`),
        declineReason: secret(`decline-${kind}`),
        intakeAnswers: [{ id: "q1", label: "Question", answer: secret(`intake-${kind}`) }],
        ...extra,
      },
    });
  };
  const pay = (bookingId: string, kind: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
    prisma.payment.create({
      data: {
        bookingId,
        createdAt,
        providerOrderId: `order_${run}_${kind}`,
        providerPaymentId: `pay_${run}_${kind}`,
        amountMinor: 105050,
        currency: "INR",
        status: "CAPTURED",
        failureReason: secret(`failure-${kind}`),
        recoveryError: secret(`recovery-${kind}`),
        reconciledAt: at(DAY / 2),
        reconciledByEmail: emailY,
        ...extra,
      },
    });

  // Inside the day: a normal one with a formula-looking influencer and service name, a partly refunded one, and one at 00:00:00.000 exactly.
  const normal = await booking("normal", at(12 * 3_600_000));
  await pay(normal.id, "normal", at(12 * 3_600_000 + 5));
  const partial = await booking("partial", at(13 * 3_600_000));
  await pay(partial.id, "partial", at(13 * 3_600_000 + 5), { refundAmountMinor: 5000, refundStatus: "processed", needsRefund: true });
  const midnight = await booking("midnight", at(0));
  await pay(midnight.id, "midnight", at(0), { status: "REFUNDED", refundAmountMinor: 105050, refundStatus: "processed" });
  // Erased customer, inside the day.
  const erased = await booking("erased", at(14 * 3_600_000), { redactedAt: new Date(), customerName: "Erased customer", customerEmail: `erased+${run}@invalid.invalid`, whatsappE164: "", lastError: null, intakeAnswers: undefined });
  await pay(erased.id, "erased", at(14 * 3_600_000 + 5));
  // Outside the day: one millisecond before it, and exactly at the start of the next day (the end is exclusive).
  const early = await booking("before", at(-1));
  await pay(early.id, "before", at(-1));
  const late = await booking("after", at(DAY));
  await pay(late.id, "after", at(DAY));

  const payoutBase = { influencerId, currency: "INR", grossMinor: 105050, refundsMinor: 5000, feeBps: 1050, feeMinor: 10500, netMinor: 89550, paymentCount: 2, destination: "UPI ****1234", createdByEmail: emailY, note: secret("payout-note") };
  await prisma.payout.create({ data: { ...payoutBase, createdAt: at(15 * 3_600_000), status: "PAID", reference: `UTR${run}`, paidAt: at(16 * 3_600_000), paidByEmail: emailX, approvedAt: at(15.5 * 3_600_000), approvedByEmail: emailX } });
  await prisma.payout.create({ data: { ...payoutBase, createdAt: at(DAY), status: "PENDING", reference: null } });

  await prisma.adminAuditLog.createMany({
    data: [0, 1, 2].map((i) => ({
      adminEmail: auditEmail,
      action: `test.export.${i}`,
      targetType: "payout",
      targetId: `target-${run}-${i}`,
      detail: { marker: secret(`audit-detail-${i}`) },
      ip: "203.0.113.7",
      createdAt: at(i * 1000),
    })),
  });
}

before(async () => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  delete process.env.REDIS_URL;
  process.env.ADMIN_REQUIRE_2FA = "false";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  exportsLib = await import("../lib/admin/exports");
  // The route gets the real exports module, except that the row cap can be lowered from the test.
  mock.module("@/lib/admin/exports", {
    namedExports: { ...exportsLib, buildExport: (kind: never, r: never) => exportsLib.buildExport(kind, r, capOverride === undefined ? {} : { rowCap: capOverride }) },
  });
  GET = (await import("../app/api/admin/exports/[kind]/route")).GET as Handler;

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Export Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Export Admin Y", passwordHash: hash } })).id;
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  const past = Date.now() - 60_000;
  const s = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(s, past), null, past)).ok);
  await seed();
});

after(async () => {
  try {
    if (!skip) {
      const steps: [string, () => Promise<unknown>][] = [
        ["payouts", () => prisma.payout.deleteMany({ where: { influencer: { slug } } })],
        ["influencer", () => prisma.influencer.deleteMany({ where: { slug } })],
        ["audit", () => prisma.adminAuditLog.deleteMany({ where: { OR: [{ adminEmail: { in: [emailX, emailY, auditEmail] } }, { targetId: { contains: run } }] } })],
        ["admins", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY] } } })],
      ];
      for (const [name, step] of steps) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await step();
            break;
          } catch (e) {
            if (attempt === 2) console.error(`[admin-exports cleanup] ${name} failed:`, e instanceof Error ? e.message : e);
          }
        }
      }
    }
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await prisma.$disconnect().catch(() => {});
  }
});

test("every kind: 401 without an administrator session (or with a garbage cookie), 403 enroll / verify, 200 for an admin who may", { skip }, async () => {
  const plain = await sessionLib.createAdminSession(Y);
  const stale = await passwordOnlySession(X);
  const verified = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });
  const denied = async (res: Response, action: "enroll" | "verify", where: string) => {
    assert.equal(res.status, 403, where);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.mfaRequired, true, where);
    assert.equal(body.mfaAction, action, where);
    assert.deepEqual(keys(body), ["error", "mfaAction", "mfaRequired"], `${where}: nothing of the export leaks to a denied session`);
  };
  for (const kind of EXPORT_KINDS) {
    for (const cookie of [undefined, "", "not-a-real-admin-session-token"]) {
      const res = await ask(kind, range(), cookie);
      assert.equal(res.status, 401, `${kind} ${JSON.stringify(cookie)}`);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(keys(body), ["error"]);
      assertNoSecretKeys(body);
    }
    await denied(await ask(kind, range(), stale), "verify", `${kind}: password-only session of a 2FA admin`);
    const ok = await ask(kind, range(), plain);
    assert.equal(ok.status, 200, `${kind}: ok`);
    await ok.text();
  }
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    for (const kind of EXPORT_KINDS) {
      await denied(await ask(kind, range(), plain), "enroll", `${kind}: must enrol`);
      await denied(await ask(kind, range(), stale), "verify", `${kind}: password-only session, 2FA required`);
      const ok = await ask(kind, range(), verified);
      assert.equal(ok.status, 200, `${kind}: a session that passed the second factor`);
      await ok.text();
    }
  } finally {
    process.env.ADMIN_REQUIRE_2FA = "false";
  }
});

test("an unknown kind is 404, a bad or too long range is 400, both with only an error sentence", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  for (const kind of ["", "payment", "PAYMENTS", "..%2Fpayments", "all", "__proto__", "constructor"]) {
    const res = await ask(kind, range(), token);
    assert.equal(res.status, 404, kind);
    assert.deepEqual(keys(await res.json()), ["error"]);
  }
  const cases: [string, RegExp][] = [
    ["?from=2026-02-31&to=2026-03-01", /start date/],
    ["?from=2026-03-01&to=2026-13-01", /end date/],
    ["?from=abc", /start date/],
    ["?to=2026-1-1", /end date/],
    ["?from=2026-10-12&to=2026-10-11", /after the end/],
    ["?from=2000-01-01&to=2100-12-31", /at most 366 days/],
    ["?from=2025-10-10&to=2026-10-11", /at most 366 days/],
  ];
  for (const kind of EXPORT_KINDS) {
    for (const [query, message] of cases) {
      const res = await ask(kind, query, token);
      assert.equal(res.status, 400, `${kind}${query}`);
      const body = (await res.json()) as { error: string };
      assert.deepEqual(keys(body), ["error"]);
      assert.match(body.error, message, `${kind}${query}`);
    }
  }
});

const HEADERS = {
  payments: ["created_at", "payment_id", "provider_payment_id", "provider_order_id", "status", "amount", "refunded", "currency", "needs_refund", "refund_status", "reconciled_at", "reconciled_by", "payout_id", "booking_id", "booking_status", "influencer_slug", "influencer_name", "service_title", "session_start", "customer_name"],
  bookings: ["created_at", "booking_id", "status", "influencer_slug", "service_title", "service_type", "session_start", "customer_name", "customer_email", "paid", "refunded", "currency", "meet_link_created"],
  payouts: ["created_at", "payout_id", "influencer_slug", "status", "currency", "gross", "refunds", "fee_bps", "fee", "net", "payment_count", "destination", "reference", "created_by", "approved_by", "approved_at", "paid_by", "paid_at"],
  audit: ["created_at", "admin_email", "action", "target_type", "target_id", "ip"],
};

async function csvOf(kind: string, query = range()) {
  const token = await sessionLib.createAdminSession(Y);
  const res = await ask(kind, query, token);
  assert.equal(res.status, 200, `${kind}${query}`);
  const text = await res.text();
  return { res, text, rows: parseCsv(text) };
}

test("each export: the headers of the download, the header row exactly, and only this run's rows of the chosen day", { skip }, async () => {
  for (const kind of EXPORT_KINDS) {
    const { res, rows } = await csvOf(kind);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8", kind);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${kind}-${FROM}-to-${FROM}.csv"`, kind);
    assert.equal(res.headers.get("cache-control"), "no-store", kind);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(rows[0], HEADERS[kind], `${kind}: header row`);
    for (const r of rows) assert.equal(r.length, HEADERS[kind].length, `${kind}: every row has ${HEADERS[kind].length} cells`);
  }
  // Rows of the day only: 4 payments / bookings (normal, partial, midnight, erased), 1 payout, 3 audit entries. Start inclusive, end exclusive.
  assert.equal((await csvOf("payments")).rows.length - 1, 4);
  assert.equal((await csvOf("bookings")).rows.length - 1, 4);
  assert.equal((await csvOf("payouts")).rows.length - 1, 1);
  assert.equal((await csvOf("audit")).rows.length - 1, 3);
  // A longer range takes in the neighbours; `to` is inclusive of its whole day.
  const next = dayOf(at(DAY));
  const prev = dayOf(at(-DAY));
  assert.equal((await csvOf("payments", range(FROM, next))).rows.length - 1, 5, "the payment at 00:00 of the next day is in when that day is `to`");
  assert.equal((await csvOf("payments", range(prev, FROM))).rows.length - 1, 5, "the payment one millisecond before the day is in when the previous day is `from`");
  assert.equal((await csvOf("payouts", range(FROM, next))).rows.length - 1, 2);
});

test("every export starts with a UTF-8 byte order mark (Excel on Windows), and a non-Latin name survives it", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const customer = await prisma.booking.findFirstOrThrow({ where: { session: { service: { influencerId } }, customerName: { startsWith: "Export normal" } }, select: { id: true } });
  await prisma.booking.update({ where: { id: customer.id }, data: { customerName: `Åsa 李雷 ${run}` } });
  try {
    await bomChecks(token);
  } finally {
    await prisma.booking.update({ where: { id: customer.id }, data: { customerName: `Export normal ${run}` } });
  }
});

async function bomChecks(token: string) {
  for (const kind of EXPORT_KINDS) {
    const res = await ask(kind, range(), token);
    assert.equal(res.status, 200, kind);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], `${kind}: BOM`);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("\uFEFF" + HEADERS[kind][0]), `${kind}: header right after the BOM`);
    if (kind === "bookings") assert.ok(text.includes(`Åsa 李雷 ${run}`));
  }
}

test("payments: money as decimals, refunded amounts, flags, the erased customer, and formula-looking names are neutralised", { skip }, async () => {
  const { rows } = await csvOf("payments");
  const col = (name: string) => HEADERS.payments.indexOf(name);
  const by = (kind: string) => rows.find((r) => r[col("provider_payment_id")] === `pay_${run}_${kind}`)!;
  const normal = by("normal");
  assert.equal(normal[col("amount")], "1050.50");
  assert.equal(normal[col("refunded")], "0.00");
  assert.equal(normal[col("currency")], "INR");
  assert.equal(normal[col("status")], "CAPTURED");
  assert.equal(normal[col("needs_refund")], "no");
  assert.equal(normal[col("booking_status")], "SCHEDULED");
  assert.equal(normal[col("influencer_slug")], slug);
  assert.equal(normal[col("created_at")], at(12 * 3_600_000 + 5).toISOString());
  assert.equal(normal[col("reconciled_by")], emailY);
  assert.equal(normal[col("customer_name")], `Export normal ${run}`);
  assert.equal(normal[col("influencer_name")], `'+Export Owner ${run}`, "a name that starts with + is prefixed with a quote");
  assert.equal(normal[col("service_title")], `'@Export call ${run}`, "a title that starts with @ is prefixed with a quote");
  assert.equal(by("partial")[col("refunded")], "50.00");
  assert.equal(by("partial")[col("needs_refund")], "yes");
  assert.equal(by("partial")[col("refund_status")], "processed");
  assert.equal(by("midnight")[col("status")], "REFUNDED");
  assert.equal(by("midnight")[col("refunded")], "1050.50");
  assert.equal(by("erased")[col("customer_name")], "(erased)");
  assert.ok(!rows.flat().some((cell) => cell.includes("Erased customer")), "the stored placeholder name is not exported");
  // No cell of any row of the file may begin with a formula character.
  for (const r of rows.slice(1)) for (const cell of r) assert.ok(!/^[=+\-@\t\r]/.test(cell), `a cell starts with a formula character: ${cell}`);
});

test("bookings: e-mail (empty when erased), paid / refunded totals, `yes`/`no` for the Meet link and never the link, the phone or the intake answers", { skip }, async () => {
  const { rows, text } = await csvOf("bookings");
  const col = (name: string) => HEADERS.bookings.indexOf(name);
  const by = (kind: string) => rows.find((r) => r[col("customer_name")] === `Export ${kind} ${run}` || (kind === "erased" && r[col("customer_name")] === "(erased)"))!;
  const normal = by("normal");
  assert.equal(normal[col("customer_email")], `export-normal-${run}@example.com`);
  assert.equal(normal[col("paid")], "1050.50");
  assert.equal(normal[col("refunded")], "0.00");
  assert.equal(normal[col("meet_link_created")], "yes");
  assert.equal(normal[col("service_type")], "ONE_TO_ONE");
  assert.equal(normal[col("currency")], "INR");
  assert.equal(by("partial")[col("refunded")], "50.00");
  const erased = rows.find((r) => r[col("customer_name")] === "(erased)")!;
  assert.ok(erased, "the erased booking is in the file");
  assert.equal(erased[col("customer_email")], "", "no e-mail for an erased customer");
  assert.ok(!text.includes("invalid.invalid") && !text.includes("Erased customer"));
  assert.ok(!text.includes("meet.google.com"), "never the Meet URL");
});

test("payouts: money as decimals, the masked destination, who created / approved / paid; the free-form note is not exported", { skip }, async () => {
  const { rows, text } = await csvOf("payouts");
  const col = (name: string) => HEADERS.payouts.indexOf(name);
  const row = rows[1];
  assert.equal(row[col("influencer_slug")], slug);
  assert.equal(row[col("status")], "PAID");
  assert.equal(row[col("gross")], "1050.50");
  assert.equal(row[col("refunds")], "50.00");
  assert.equal(row[col("fee_bps")], "1050");
  assert.equal(row[col("fee")], "105.00");
  assert.equal(row[col("net")], "895.50");
  assert.equal(row[col("payment_count")], "2");
  assert.equal(row[col("destination")], "UPI ****1234");
  assert.equal(row[col("reference")], `UTR${run}`);
  assert.equal(row[col("created_by")], emailY);
  assert.equal(row[col("approved_by")], emailX);
  assert.equal(row[col("paid_by")], emailX);
  assert.equal(row[col("paid_at")], at(16 * 3_600_000).toISOString());
  assert.ok(!text.includes(hidden.find((h) => h.includes("payout-note"))!));
});

test("audit: the log without its free-form detail, oldest first", { skip }, async () => {
  const { rows, text } = await csvOf("audit");
  assert.deepEqual(rows.slice(1).map((r) => r[2]), ["test.export.0", "test.export.1", "test.export.2"]);
  assert.deepEqual(rows[1], [at(0).toISOString(), auditEmail, "test.export.0", "payout", `target-${run}-0`, "203.0.113.7"]);
  assert.ok(!text.includes("hidden-audit-detail") && !text.includes("marker"));
});

test("nothing secret leaves in any export: no phone, Meet link, event id, intake answer, decline reason, error text, failure or recovery text, note or audit detail", { skip }, async () => {
  for (const kind of EXPORT_KINDS) {
    const { text } = await csvOf(kind, range(dayOf(at(-DAY)), dayOf(at(DAY))));
    for (const value of hidden) assert.ok(!text.includes(value), `${kind} export holds ${value}`);
    assert.ok(!/hash|secret|token|_enc|password/i.test(text.split("\r\n")[0]), `${kind}: no such column`);
  }
  assert.ok(hidden.length > 20, "the hidden values were really stored");
});

test("every export is audited before the file is returned: `admin.export` with the kind, the range and the row count", { skip }, async () => {
  const expectedRows: Record<string, number> = { payments: 4, bookings: 4, payouts: 1, audit: 3 };
  for (const kind of EXPORT_KINDS) {
    const startedAt = new Date();
    const { rows } = await csvOf(kind);
    const entry = await prisma.adminAuditLog.findFirst({
      where: { adminEmail: emailY, action: "admin.export", targetId: kind, createdAt: { gte: startedAt } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(entry, `${kind}: an audit entry`);
    assert.equal(entry.targetType, "export");
    assert.deepEqual(entry.detail, { kind, from: FROM, to: FROM, rows: expectedRows[kind] });
    assert.equal(rows.length - 1, expectedRows[kind]);
  }
});

test("a range with more rows than the cap is refused with 400 and the honest message, and is not audited or sent", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  capOverride = 2;
  try {
    const startedAt = new Date();
    for (const kind of ["payments", "bookings", "audit"]) {
      const res = await ask(kind, range(), token);
      assert.equal(res.status, 400, kind);
      assert.deepEqual(await res.json(), { error: "More than 2 rows. Choose a shorter range." });
    }
    assert.equal(await prisma.adminAuditLog.count({ where: { adminEmail: emailY, action: "admin.export", createdAt: { gte: startedAt } } }), 0, "a refused export wrote no audit entry");
    // Exactly at the cap is fine ("more than" the cap is refused).
    const exact = await ask("payouts", range(), token);
    assert.equal(exact.status, 200);
    assert.equal(parseCsv(await exact.text()).length - 1, 1);
    capOverride = 1;
    const one = await ask("payouts", range(), token);
    assert.equal(one.status, 200, "1 row, cap 1");
    await one.text();
    capOverride = 3;
    const three = await ask("audit", range(), token);
    assert.equal(three.status, 200, "3 rows, cap 3");
    await three.text();
  } finally {
    capOverride = undefined;
  }
  // The same through the library, which is what the route uses.
  const r = exportsLib.parseExportRange(new URLSearchParams(`from=${FROM}&to=${FROM}`));
  assert.ok(r.ok);
  await assert.rejects(exportsLib.buildExport("payments", r.range, { rowCap: 3 }), ExportTooLargeError);
  assert.equal((await exportsLib.buildExport("payments", r.range, { rowCap: 4 })).length, 5);
});

test("if the audit entry cannot be written, no data is returned", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const real = prisma.adminAuditLog.create;
  (prisma.adminAuditLog as { create: unknown }).create = async () => {
    throw new Error("audit store down");
  };
  try {
    jar.clear();
    jar.set(sessionLib.adminCookieName(), token);
    await assert.rejects(GET(new Request("http://localhost/api/admin/exports/payments" + range()), { params: Promise.resolve({ kind: "payments" }) }), /audit store down/);
  } finally {
    (prisma.adminAuditLog as { create: unknown }).create = real;
  }
});
