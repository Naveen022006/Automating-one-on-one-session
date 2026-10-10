import "dotenv/config";
import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { hashPassword, passwordProblem } from "../lib/auth/password";

// Usage: npm run admin:create -- --email you@company.com --name "Your Name" [--reset]
// The password comes from ADMIN_PASSWORD, or a strong one is generated and printed once. --reset changes the
// password of an existing admin and re-enables a disabled one. --reset-2fa (instead of creating anything) turns
// two-factor off for an admin who lost their authenticator and recovery codes; it is audit-logged.

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim() || "Administrator";
  const reset = process.argv.includes("--reset");
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('Usage: npm run admin:create -- --email you@company.com --name "Your Name" [--reset | --reset-2fa]');
  }

  if (process.argv.includes("--reset-2fa")) {
    // Lost both the authenticator and the recovery codes: turn two-factor off so the admin can sign in with the
    // password and enrol again (with ADMIN_REQUIRE_2FA on, the console sends them straight to /admin/security).
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    if (!admin) throw new Error(`${email} is not an admin.`);
    await prisma.$transaction([
      prisma.adminUser.update({
        where: { id: admin.id },
        data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, mfaFailedCount: 0, mfaLockLevel: 0, mfaLockedUntil: null },
      }),
      prisma.adminRecoveryCode.deleteMany({ where: { adminId: admin.id } }),
      prisma.adminSession.deleteMany({ where: { adminId: admin.id } }),
      prisma.adminAuditLog.create({ data: { adminId: admin.id, adminEmail: "cli", action: "admin.2fa_reset_cli", targetType: "admin", targetId: admin.id } }),
    ]);
    console.log(`Two-factor authentication turned off for ${email}; all their sessions were ended.`);
    return;
  }

  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || randomBytes(15).toString("base64url");
  const problem = passwordProblem(password, { email, name });
  if (problem) throw new Error(`Password rejected: ${problem}`);

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing && !reset) throw new Error(`${email} is already an admin. Pass --reset to set a new password.`);

  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.adminUser.update({ where: { id: existing.id }, data: { passwordHash, name, disabledAt: null } });
    await prisma.adminSession.deleteMany({ where: { adminId: existing.id } });
  } else {
    await prisma.adminUser.create({ data: { email, name, passwordHash } });
  }
  console.log(`${existing ? "Updated" : "Created"} admin ${email}`);
  if (generated) console.log(`Password (shown once, change it after signing in): ${password}`);
  console.log("Sign in at /admin/login");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
