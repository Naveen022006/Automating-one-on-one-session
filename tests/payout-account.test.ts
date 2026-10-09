import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decryptSecret } from "../lib/crypto";
import { prisma } from "../lib/db";
import {
  getPayoutAccountView,
  hasVerifiedPayoutAccount,
  maskAccountNumber,
  maskUpiId,
  payoutInputSchema,
  revealPayoutAccount,
  reviewPayoutAccount,
  savePayoutAccount,
} from "../lib/payout-account";

const bank = {
  method: "BANK",
  accountHolderName: "Asha Rao",
  bankName: "HDFC Bank",
  ifsc: "hdfc0001234",
  accountNumber: "123456789012",
  confirmAccountNumber: "1234 5678 9012",
};

test("bank details are normalised and validated", () => {
  const ok = payoutInputSchema.safeParse(bank);
  assert.equal(ok.success, true);
  if (ok.success && ok.data.method === "BANK") {
    assert.equal(ok.data.ifsc, "HDFC0001234");
    assert.equal(ok.data.accountNumber, "123456789012");
  }
  const bad = (patch: Record<string, unknown>) => payoutInputSchema.safeParse({ ...bank, ...patch }).success;
  assert.equal(bad({ ifsc: "HDFC123" }), false, "IFSC must be 4 letters, a zero, then 6 characters");
  assert.equal(bad({ ifsc: "HDFC1001234" }), false, "5th IFSC character must be 0");
  assert.equal(bad({ accountNumber: "12345" }), false, "too short");
  assert.equal(bad({ accountNumber: "12345678901234567890" }), false, "too long");
  assert.equal(bad({ accountNumber: "1234abcd5678" }), false, "digits only");
  assert.equal(bad({ confirmAccountNumber: "999999999999" }), false, "confirmation must match");
  assert.equal(bad({ accountHolderName: "A1" }), false, "letters only");
  assert.equal(bad({ bankName: "" }), false);
});

test("UPI ids are validated and lowercased", () => {
  const ok = payoutInputSchema.safeParse({ method: "UPI", accountHolderName: "Asha Rao", upiId: " Asha.Rao@OkHDFCBank " });
  assert.equal(ok.success, true);
  if (ok.success && ok.data.method === "UPI") assert.equal(ok.data.upiId, "asha.rao@okhdfcbank");
  for (const upiId of ["no-at-sign", "@bank", "a@", "x y@bank", "name@1bank"]) {
    assert.equal(payoutInputSchema.safeParse({ method: "UPI", accountHolderName: "Asha Rao", upiId }).success, false, upiId);
  }
});

test("masking never reveals more than the last four digits / two handle characters", () => {
  assert.equal(maskAccountNumber("123456789012"), "XXXXXXXX9012");
  assert.equal(maskAccountNumber("1234567890"), "XXXXXX7890");
  assert.equal(maskUpiId("asha.rao@okhdfcbank"), "as******@okhdfcbank");
  assert.equal(maskUpiId("ab@upi"), "ab***@upi", "short handles still get a minimum mask");
});

// Integration tests: need a migrated Postgres at DATABASE_URL and TOKEN_ENCRYPTION_KEY (skipped otherwise).
const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY not set";
const run = Date.now();
let a: string;
let b: string;

before(async () => {
  if (skip) return;
  a = (await prisma.influencer.create({ data: { slug: `po-a-${run}`, name: "A", email: `po-a-${run}@example.com` } })).id;
  b = (await prisma.influencer.create({ data: { slug: `po-b-${run}`, name: "B", email: `po-b-${run}@example.com` } })).id;
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [a, b].filter(Boolean) } } });
  await prisma.$disconnect();
});

test("details are stored encrypted, shown masked, and revealed in full only on request", { skip }, async () => {
  const parsed = payoutInputSchema.parse(bank);
  const view = await savePayoutAccount(a, parsed);
  assert.equal(view.accountNumber, "XXXXXXXX9012");
  assert.equal(view.status, "PENDING_REVIEW");

  const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId: a } });
  assert.ok(row.accountNumberEnc && !row.accountNumberEnc.includes("123456789012"), "number is not stored in plaintext");
  assert.equal(JSON.stringify(await getPayoutAccountView(a)).includes("123456789012"), false);

  const full = await revealPayoutAccount(a);
  assert.equal(full?.accountNumber, "123456789012");
});

test("a ciphertext copied onto another influencer cannot be decrypted", { skip }, async () => {
  const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId: a } });
  assert.throws(() => decryptSecret(row.accountNumberEnc!, `payout:${b}:account`));
});

test("only verified details count, and any change sends them back for review", { skip }, async () => {
  assert.equal(await hasVerifiedPayoutAccount(a), false);
  await reviewPayoutAccount(a, { verified: true }, "admin@example.com");
  assert.equal(await hasVerifiedPayoutAccount(a), true);

  await savePayoutAccount(a, payoutInputSchema.parse({ ...bank, accountNumber: "999988887777", confirmAccountNumber: "999988887777" }));
  assert.equal(await hasVerifiedPayoutAccount(a), false, "changed details must be re-verified");
  assert.equal((await getPayoutAccountView(a))?.status, "PENDING_REVIEW");

  const rejected = await reviewPayoutAccount(a, { verified: false, reason: "Name does not match PAN" }, "admin@example.com");
  assert.equal(rejected?.status, "REJECTED");
  assert.equal(rejected?.rejectionReason, "Name does not match PAN");
  assert.equal(await reviewPayoutAccount(b, { verified: true }, "admin@example.com"), null, "no details yet");
});

test("switching to UPI clears the bank fields", { skip }, async () => {
  const view = await savePayoutAccount(a, payoutInputSchema.parse({ method: "UPI", accountHolderName: "Asha Rao", upiId: "asha@okaxis" }));
  assert.equal(view.method, "UPI");
  assert.equal(view.accountNumber, null);
  const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId: a } });
  assert.equal(row.accountNumberEnc, null);
  assert.equal((await revealPayoutAccount(a))?.upiId, "asha@okaxis");
});
