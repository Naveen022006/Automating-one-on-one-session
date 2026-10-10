import "dotenv/config";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { hashPassword, passwordProblem } from "../lib/auth/password";

// Local test logins, for trying the influencer dashboard and the admin console by hand.
//
//   npm run dev:logins               create (or refresh) the test logins and write them to dev-logins.local.md
//   npm run dev:logins -- --remove   delete them again
//
// Passwords are random and are written only to dev-logins.local.md (gitignored), never printed. Running it again
// issues new passwords and ends the old sessions. It refuses to run unless APP_URL is a local address, because the
// logins are meant for a development machine only. The demo influencer (slug "demo") comes from `npm run db:seed`.

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const DEMO_INFLUENCER_EMAIL = "demo@example.com";
const ADMINS = [
  { email: "admin1@example.com", name: "Test Admin One" },
  { email: "admin2@example.com", name: "Test Admin Two" },
];
const OUT_FILE = resolve(process.cwd(), "dev-logins.local.md");

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

function newPassword(context: { email: string; name: string }): string {
  for (let i = 0; i < 20; i++) {
    const p = randomBytes(12).toString("base64url");
    if (!passwordProblem(p, context)) return p;
  }
  throw new Error("Could not generate an acceptable password.");
}

async function remove() {
  const users = await prisma.user.deleteMany({ where: { email: DEMO_INFLUENCER_EMAIL } });
  const admins = await prisma.adminUser.deleteMany({ where: { email: { in: ADMINS.map((a) => a.email) } } });
  console.log(`Removed ${users.count} influencer login and ${admins.count} admin logins. The demo influencer profile and its services were left alone.`);
}

async function create() {
  const url = appUrl();
  if (process.env.NODE_ENV === "production" || !isLocal(url)) {
    throw new Error(`Refusing to create test logins: APP_URL (${url.origin}) is not a local address.`);
  }

  const influencer = await prisma.influencer.findUnique({ where: { slug: "demo" } });
  if (!influencer) throw new Error('The demo influencer does not exist yet. Run "npm run db:seed" first.');

  const rows: { role: string; email: string; password: string; where: string }[] = [];

  const influencerPassword = newPassword({ email: DEMO_INFLUENCER_EMAIL, name: influencer.name });
  const passwordHash = await hashPassword(influencerPassword);
  const user = await prisma.user.upsert({
    where: { email: DEMO_INFLUENCER_EMAIL },
    update: { passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: new Date(), influencerId: influencer.id },
    create: { email: DEMO_INFLUENCER_EMAIL, passwordHash, emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId: influencer.id },
  });
  await prisma.authSession.deleteMany({ where: { userId: user.id } });
  rows.push({ role: "Influencer (Demo Creator)", email: DEMO_INFLUENCER_EMAIL, password: influencerPassword, where: `${url.origin}/login` });

  for (const a of ADMINS) {
    const password = newPassword(a);
    const hash = await hashPassword(password);
    const admin = await prisma.adminUser.upsert({
      where: { email: a.email },
      update: { name: a.name, passwordHash: hash, disabledAt: null },
      create: { email: a.email, name: a.name, passwordHash: hash },
    });
    await prisma.adminSession.deleteMany({ where: { adminId: admin.id } });
    rows.push({ role: `Admin (${a.name})`, email: a.email, password, where: `${url.origin}/admin/login` });
  }

  const md = [
    "# Local test logins",
    "",
    `Created ${new Date().toISOString()} by \`npm run dev:logins\`. For this development machine only. This file is gitignored: do not commit or share it.`,
    "Run the command again for new passwords, or with `-- --remove` to delete these logins.",
    "",
    "| Role | Email | Password | Sign in at |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.role} | ${r.email} | \`${r.password}\` | ${r.where} |`),
    "",
    "- The influencer lands on `/dashboard`: services, availability, sessions, customers, earnings, payouts, messages, settings.",
    "- The admin lands on `/admin`: payments, bookings, influencers, payouts, audit log, health, security, settings.",
    "- Two admins exist so payout approval by a second person (`PAYOUT_FOUR_EYES=true`) can be tried: sign in as one in a normal window and the other in a private window.",
    "",
  ].join("\n");
  writeFileSync(OUT_FILE, md, { encoding: "utf8", mode: 0o600 });
  console.log(`Test logins created. Open ${OUT_FILE} for the emails and passwords.`);
}

(process.argv.includes("--remove") ? remove() : create())
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
