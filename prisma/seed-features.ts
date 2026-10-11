import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { hashPassword } from "../lib/auth/password";
import { encryptSecret } from "../lib/crypto";

// Demo data for the marketplace features (doc/13-product-build-plan.md, section 0.8): moderation, admin money operations,
// the customer portal, the reminder window and the finance report all need rows that a fresh `npm run db:seed` does not have.
//
//   npm run db:seed:features               create the rows (safe to run again: nothing is duplicated)
//   npm run db:seed:features -- --remove   delete everything this script created, and nothing else
//
// Requires `npm run db:seed` first (the demo influencer and its 1:1 service). Refuses to run unless APP_URL is a local address.
// EVERY row it creates is recognisable: ids start with "seedfeat_", e-mails contain "seedfeat", provider ids are
// order_SEEDFEAT_* / pay_SEEDFEAT_* / rfnd_SEEDFEAT_*. Never run a worker connected to real providers against this data;
// refunds of pay_SEEDFEAT_* are rejected by Razorpay (a definite 4xx), which is the error path to try. A real refund demo
// needs a real test-mode payment.

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const PREFIX = "seedfeat_";
const CUSTOMER_EMAIL = "customer.seedfeat@example.com";
const CUSTOMER_NAME = "Asha Seed";
// Not a dialable number (an Indian mobile number never starts with 0): the seed can never message a real person.
const CUSTOMER_PHONE = "+910000000000";
const REVIEW = {
  id: `${PREFIX}inf_review`,
  userId: `${PREFIX}user_review`,
  serviceId: `${PREFIX}svc_review`,
  payoutAccountId: `${PREFIX}pa_review`,
  slug: "review-demo",
  name: "Review Demo",
  email: "review.seedfeat@example.com",
};
const PAYOUT_ID = `${PREFIX}payout_1`;
const DAY = 86_400_000;
const TZ = "Asia/Kolkata";

function appUrl(): URL {
  try {
    return new URL(process.env.APP_URL || "http://localhost:3000");
  } catch {
    throw new Error("APP_URL is not a valid URL.");
  }
}

function isLocal(u: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
}

/** The UTC day `offsetDays` from today at 10:07 UTC. The odd minute keeps seeded sessions off the real slot grid (never a clash). */
function at(offsetDays: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + offsetDays * DAY + (10 * 60 + 7) * 60_000);
}

async function remove() {
  // Order matters: bookings take their payments (and refunds, messages) with them; the payout is only referenced by those payments.
  const bookings = await prisma.booking.deleteMany({ where: { id: { startsWith: PREFIX } } });
  const sessions = await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
  const payouts = await prisma.payout.deleteMany({ where: { id: { startsWith: PREFIX } } });
  const tokens = await prisma.customerAccessToken.deleteMany({ where: { email: CUSTOMER_EMAIL } });
  const influencers = await prisma.influencer.deleteMany({ where: { id: REVIEW.id } }); // services, rules, payout account, login cascade
  console.log(
    `Removed ${influencers.count} influencer, ${bookings.count} bookings, ${sessions.count} sessions, ${payouts.count} payout, ${tokens.count} portal access tokens (payments and refunds went with their bookings).`,
  );
}

async function create() {
  const demo = await prisma.influencer.findUnique({ where: { slug: "demo" } });
  if (!demo) throw new Error('The demo influencer does not exist yet. Run "npm run db:seed" first.');
  const demoService = await prisma.service.findFirst({ where: { influencerId: demo.id, type: "ONE_TO_ONE" }, orderBy: { createdAt: "asc" } });
  if (!demoService) throw new Error('The demo influencer has no 1:1 service. Run "npm run db:seed" first.');
  if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error("TOKEN_ENCRYPTION_KEY is not set (the demo payout details are stored encrypted).");

  // --- review-demo: onboarded, NOT approved, so it shows up under "Awaiting approval" when READINESS_REQUIRED contains `approval`.
  const clash = await prisma.influencer.findFirst({
    where: { OR: [{ slug: REVIEW.slug }, { email: REVIEW.email }], NOT: { id: REVIEW.id } },
    select: { id: true },
  });
  if (clash) throw new Error(`An influencer that this script did not create already uses the slug "${REVIEW.slug}" or ${REVIEW.email}. Nothing was changed.`);

  const reviewExisted = (await prisma.influencer.count({ where: { id: REVIEW.id } })) > 0;
  await prisma.influencer.upsert({
    where: { id: REVIEW.id },
    update: {},
    create: {
      id: REVIEW.id,
      slug: REVIEW.slug,
      name: REVIEW.name,
      email: REVIEW.email,
      timezone: TZ,
      bio: "Seed data for the approval queue (npm run db:seed:features). Awaiting platform review.",
      onboardedAt: new Date(),
      approvedAt: null,
      approvedByEmail: null,
    },
  });
  if (!reviewExisted) {
    // A verified login nobody can use: the password is random and thrown away, so the account can be live (e-mail verified)
    // without being a way in.
    await prisma.user.create({
      data: {
        id: REVIEW.userId,
        email: REVIEW.email,
        passwordHash: await hashPassword(randomBytes(24).toString("base64url")),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        influencerId: REVIEW.id,
      },
    });
    await prisma.service.create({
      data: {
        id: REVIEW.serviceId,
        influencerId: REVIEW.id,
        title: "1:1 Review Call",
        description: "30 minutes. Seed data.",
        durationMin: 30,
        priceMinor: 29900,
        type: "ONE_TO_ONE",
        capacity: 1,
        refundPolicy: "NOTICE_24H",
      },
    });
    await prisma.availabilityRule.createMany({
      data: [1, 2, 3, 4, 5].map((weekday) => ({
        id: `${PREFIX}rule_review_${weekday}`,
        influencerId: REVIEW.id,
        weekday,
        startTime: "10:00",
        endTime: "17:00",
        timezone: TZ,
      })),
    });
    await prisma.payoutAccount.create({
      data: {
        id: REVIEW.payoutAccountId,
        influencerId: REVIEW.id,
        method: "BANK",
        accountHolderName: REVIEW.name,
        bankName: "Demo Bank",
        ifsc: "DEMO0000001",
        accountNumberEnc: encryptSecret("000033334444", `payout:${REVIEW.id}:account`),
        accountNumberMasked: "XXXXXXXX4444",
        status: "VERIFIED",
        reviewedAt: new Date(),
        reviewedByEmail: "seedfeat",
      },
    });
  }

  // --- the customer on `demo`: five bookings, one payout, one refund after the payout.
  const price = demoService.priceMinor;
  const currency = demoService.currency;
  const intake = [{ id: "q1", label: "What do you want to discuss?", answer: "Interview preparation (seed data)" }];

  type Spec = {
    key: string;
    start: Date;
    status: "SCHEDULED" | "CANCELLED";
    needsRefund?: boolean;
    meetLink?: string;
    intake?: boolean;
  };
  const specs: Spec[] = [
    { key: "past1", start: at(-40), status: "SCHEDULED", meetLink: "https://meet.example.com/seedfeat-past-1", intake: true },
    { key: "past2", start: at(-30), status: "SCHEDULED", meetLink: "https://meet.example.com/seedfeat-past-2" },
    { key: "past3", start: at(-21), status: "SCHEDULED", meetLink: "https://meet.example.com/seedfeat-past-3" },
    // 20 days ahead: outside the 25-hour reminder window, so no worker ever sends anything for it.
    { key: "up", start: at(20), status: "SCHEDULED", meetLink: "https://meet.example.com/seedfeat-upcoming" },
    // Cancelled, but the customer paid: the payment is flagged for refund.
    { key: "canc", start: at(5), status: "CANCELLED", needsRefund: true },
  ];

  let createdBookings = 0;
  for (const s of specs) {
    const sessionId = `${PREFIX}ses_${s.key}`;
    const bookingId = `${PREFIX}bk_${s.key}`;
    const end = new Date(s.start.getTime() + demoService.durationMin * 60_000);
    // The upcoming session moves with the calendar on a re-run (it stays "20 days ahead"); the others never change.
    await prisma.session.upsert({
      where: { id: sessionId },
      update: s.key === "up" || s.key === "canc" ? { startTime: s.start, endTime: end } : {},
      create: { id: sessionId, serviceId: demoService.id, startTime: s.start, endTime: end },
    });
    const existed = (await prisma.booking.count({ where: { id: bookingId } })) > 0;
    const customer = {
      customerName: CUSTOMER_NAME,
      customerEmail: CUSTOMER_EMAIL,
      whatsappE164: CUSTOMER_PHONE,
      whatsappOptIn: false,
      customerTz: TZ,
      intakeAnswers: s.intake ? intake : undefined,
    };
    await prisma.booking.upsert({
      where: { id: bookingId },
      // A re-run restores the customer's details (after an erasure demo); the status and money are left as they are.
      update: { ...customer, intakeAnswers: s.intake ? intake : undefined, redactedAt: null },
      create: {
        id: bookingId,
        sessionId,
        status: s.status,
        ...customer,
        meetLink: s.meetLink,
        refundPolicy: demoService.refundPolicy,
        createdAt: new Date(s.start.getTime() - 2 * DAY),
      },
    });
    if (!existed) createdBookings++;
    await prisma.payment.upsert({
      where: { id: `${PREFIX}pay_${s.key}` },
      update: {},
      create: {
        id: `${PREFIX}pay_${s.key}`,
        bookingId,
        providerOrderId: `order_SEEDFEAT_${s.key.toUpperCase()}`,
        providerPaymentId: `pay_SEEDFEAT_${s.key.toUpperCase()}`,
        amountMinor: price,
        currency,
        status: "CAPTURED",
        needsRefund: s.needsRefund ?? false,
        failureReason: s.needsRefund ? "Booking cancelled after payment; refund needed (seed data)" : null,
        reconciledAt: new Date(s.start.getTime() - 2 * DAY + 3_600_000),
        reconciledByEmail: "seedfeat",
        createdAt: new Date(s.start.getTime() - 2 * DAY),
      },
    });
  }

  // --- a PAID payout holding past1's payment, and a processed refund on that payment made AFTER the payout was paid
  //     (the finance report shows it as "to recover").
  const fee = Math.round((price * 1000) / 10_000);
  const payoutExisted = (await prisma.payout.count({ where: { id: PAYOUT_ID } })) > 0;
  if (!payoutExisted) {
    const refunded = 10_000;
    await prisma.payout.create({
      data: {
        id: PAYOUT_ID,
        influencerId: demo.id,
        status: "PAID",
        currency,
        grossMinor: price,
        refundsMinor: 0,
        feeBps: 1000,
        feeMinor: fee,
        netMinor: price - fee,
        paymentCount: 1,
        destination: "Demo Bank XXXXXXXX2222",
        reference: "UTR-SEEDFEAT-1",
        note: "Seed data",
        createdByEmail: "seedfeat:creator",
        approvedByEmail: "seedfeat:approver",
        approvedAt: new Date(at(-40).getTime() + 8 * DAY),
        paidByEmail: "seedfeat:approver",
        paidAt: new Date(at(-40).getTime() + 8 * DAY),
        createdAt: new Date(at(-40).getTime() + 7 * DAY),
      },
    });
    await prisma.payment.update({
      where: { id: `${PREFIX}pay_past1` },
      data: { payoutId: PAYOUT_ID, refundAmountMinor: refunded, refundStatus: "processed", refundedAt: at(-20) },
    });
    await prisma.refund.create({
      data: { id: `${PREFIX}refund_1`, paymentId: `${PREFIX}pay_past1`, providerRefundId: "rfnd_SEEDFEAT_1", amountMinor: refunded, status: "processed", createdAt: at(-20) },
    });
  }

  console.log(
    [
      `Seeded (${reviewExisted ? "already present, left as it was" : "created"}): influencer /${REVIEW.slug} (onboarded, not approved, verified demo payout details; no usable login).`,
      `On /demo: ${createdBookings} new booking(s) for ${CUSTOMER_EMAIL} (${CUSTOMER_NAME}): 3 past SCHEDULED, 1 upcoming SCHEDULED (20 days ahead), 1 CANCELLED with a payment flagged needs-refund;`,
      `a PAID payout with a processed refund made after it (shows "to recover").`,
      `Approval demo: run the server with READINESS_REQUIRED=payout,approval and READINESS_BYPASS=false.`,
      `Remove everything again: npm run db:seed:features -- --remove`,
    ].join("\n"),
  );
}

async function main() {
  const url = appUrl();
  if (process.env.NODE_ENV === "production" || !isLocal(url)) {
    throw new Error(`Refusing to touch demo data: APP_URL (${url.origin}) is not a local address.`);
  }
  if (process.argv.includes("--remove")) await remove();
  else await create();
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
