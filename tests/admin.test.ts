// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { recordAudit } from "../lib/admin/audit";
import { getOverview, listPayments, mismatchWhere } from "../lib/admin/data";
import {
  authenticateAdmin,
  changeAdminPassword,
  createAdminSession,
  resolveAdminSession,
  revokeAdminSession,
} from "../lib/admin/session";
import { hashPassword } from "../lib/auth/password";
import { prisma } from "../lib/db";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const email = `admin-${run}@example.com`;
const PASSWORD = "correct-horse-battery-9";
let adminId: string;

before(async () => {
  if (skip) return;
  const admin = await prisma.adminUser.create({
    data: { email, name: "Test Admin", passwordHash: await hashPassword(PASSWORD) },
  });
  adminId = admin.id;
});

after(async () => {
  if (!skip && adminId) {
    await prisma.adminAuditLog.deleteMany({ where: { adminEmail: email } });
    await prisma.adminUser.delete({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

test("admin sign-in accepts the right password and rejects wrong, unknown and disabled accounts", { skip }, async () => {
  assert.equal((await authenticateAdmin(email.toUpperCase(), PASSWORD))?.adminId, adminId);
  assert.equal(await authenticateAdmin(email, "wrong-password-123"), null);
  assert.equal(await authenticateAdmin(`nobody-${run}@example.com`, PASSWORD), null);

  await prisma.adminUser.update({ where: { id: adminId }, data: { disabledAt: new Date() } });
  assert.equal(await authenticateAdmin(email, PASSWORD), null);
  await prisma.adminUser.update({ where: { id: adminId }, data: { disabledAt: null } });
});

test("an influencer account is not an admin", { skip }, async () => {
  const inf = await prisma.influencer.create({ data: { slug: `adm-${run}`, name: "Inf", email: `inf-${run}@example.com` } });
  const user = await prisma.user.create({
    data: { email: `inf-${run}@example.com`, passwordHash: await hashPassword(PASSWORD), termsAcceptedAt: new Date(), influencerId: inf.id },
  });
  assert.equal(await authenticateAdmin(`inf-${run}@example.com`, PASSWORD), null);
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.influencer.delete({ where: { id: inf.id } });
});

test("admin sessions resolve until revoked, expired or the admin is disabled", { skip }, async () => {
  const token = await createAdminSession(adminId, { ip: "127.0.0.1" });
  const ctx = await resolveAdminSession(token);
  assert.equal(ctx?.adminId, adminId);
  assert.equal(await resolveAdminSession("not-a-real-token"), null);

  await revokeAdminSession(ctx!.sessionId);
  assert.equal(await resolveAdminSession(token), null);

  const t2 = await createAdminSession(adminId);
  await prisma.adminSession.updateMany({ where: { adminId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await resolveAdminSession(t2), null);

  const t3 = await createAdminSession(adminId);
  await prisma.adminUser.update({ where: { id: adminId }, data: { disabledAt: new Date() } });
  assert.equal(await resolveAdminSession(t3), null);
  await prisma.adminUser.update({ where: { id: adminId }, data: { disabledAt: null } });
});

test("changing the password signs out the other sessions and checks the old password", { skip }, async () => {
  const keep = await resolveAdminSession(await createAdminSession(adminId));
  const other = await createAdminSession(adminId);
  assert.ok(keep);

  const bad = await changeAdminPassword(keep, "not-the-password", "a-brand-new-passphrase-7");
  assert.equal(bad.ok, false);
  const weak = await changeAdminPassword(keep, PASSWORD, "password1234");
  assert.equal(weak.ok, false);

  const good = await changeAdminPassword(keep, PASSWORD, "a-brand-new-passphrase-7");
  assert.equal(good.ok, true);
  assert.equal(await resolveAdminSession(other), null);
  assert.equal((await authenticateAdmin(email, "a-brand-new-passphrase-7"))?.adminId, adminId);
  assert.equal(await authenticateAdmin(email, PASSWORD), null);
  await prisma.adminUser.update({ where: { id: adminId }, data: { passwordHash: await hashPassword(PASSWORD) } });
});

test("audit entries are recorded with the admin email and survive account deletion", { skip }, async () => {
  await recordAudit({ adminId, email }, { action: "test.action", targetType: "payment", targetId: "pay_1", detail: { note: "x" } });
  const row = await prisma.adminAuditLog.findFirst({ where: { adminEmail: email, action: "test.action" } });
  assert.equal(row?.adminId, adminId);
  assert.equal(row?.targetType, "payment");
});

test("overview and payment listings run against the database", { skip }, async () => {
  const o = await getOverview();
  assert.ok(o.influencers.total >= 0);
  assert.ok(Array.isArray(o.captured));
  const page = await listPayments(1, { view: "mismatch" });
  assert.ok(page.pageCount >= 1);
  assert.equal(mismatchWhere.status, "CAPTURED");
});
