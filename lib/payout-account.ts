import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";

/**
 * Influencer payout details (where the platform owner sends earnings). Validation and masking are pure so they can
 * be unit-tested; persistence encrypts the sensitive fields and never returns them to the browser.
 */

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER = /^\d{9,18}$/;
const UPI_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export function normaliseIfsc(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function normaliseAccountNumber(value: string): string {
  return value.replace(/[\s-]+/g, "");
}

/** "XXXXXX1234": only the last four digits are ever displayed. */
export function maskAccountNumber(accountNumber: string): string {
  const last4 = accountNumber.slice(-4);
  return `${"X".repeat(Math.max(accountNumber.length - 4, 0))}${last4}`;
}

/** "ab***@okaxis": keeps the first two characters of the handle and the provider. */
export function maskUpiId(upi: string): string {
  const [handle, provider] = upi.split("@");
  return `${handle.slice(0, 2)}${"*".repeat(Math.max(handle.length - 2, 3))}@${provider}`;
}

const holderName = z
  .string()
  .trim()
  .min(2, "Enter the name exactly as it appears on the account.")
  .max(100)
  .regex(/^[\p{L}\p{M} .'-]+$/u, "Use letters only for the account holder name.");

export const payoutInputSchema = z
  .discriminatedUnion("method", [
    z.object({
      method: z.literal("BANK"),
      accountHolderName: holderName,
      bankName: z.string().trim().min(2, "Enter the bank name.").max(100),
      ifsc: z.string().transform(normaliseIfsc).pipe(z.string().regex(IFSC, "Enter a valid 11-character IFSC code, e.g. HDFC0001234.")),
      accountNumber: z
        .string()
        .transform(normaliseAccountNumber)
        .pipe(z.string().regex(ACCOUNT_NUMBER, "Account numbers are 9 to 18 digits.")),
      confirmAccountNumber: z.string().transform(normaliseAccountNumber),
    }),
    z.object({
      method: z.literal("UPI"),
      accountHolderName: holderName,
      upiId: z.string().trim().toLowerCase().pipe(z.string().regex(UPI_ID, "Enter a valid UPI ID, e.g. name@bank.")),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.method === "BANK" && v.accountNumber !== v.confirmAccountNumber) {
      ctx.addIssue({ code: "custom", path: ["confirmAccountNumber"], message: "The account numbers do not match." });
    }
  });

export type PayoutInput = z.infer<typeof payoutInputSchema>;

export interface PayoutAccountView {
  method: "BANK" | "UPI";
  accountHolderName: string;
  bankName: string | null;
  ifsc: string | null;
  /** Masked: never the full number. */
  accountNumber: string | null;
  upiId: string | null;
  status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
  rejectionReason: string | null;
  updatedAt: Date;
}

const aad = (influencerId: string, field: "account" | "upi") => `payout:${influencerId}:${field}`;
/** Shared with the key-rotation tool (lib/key-rotation-db.ts), so the two can never disagree on the AAD. */
export { aad as payoutAad };

function toView(row: {
  method: "BANK" | "UPI";
  accountHolderName: string;
  bankName: string | null;
  ifsc: string | null;
  accountNumberMasked: string | null;
  upiIdMasked: string | null;
  status: "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
  rejectionReason: string | null;
  updatedAt: Date;
}): PayoutAccountView {
  return {
    method: row.method,
    accountHolderName: row.accountHolderName,
    bankName: row.bankName,
    ifsc: row.ifsc,
    accountNumber: row.accountNumberMasked,
    upiId: row.upiIdMasked,
    status: row.status,
    rejectionReason: row.rejectionReason,
    updatedAt: row.updatedAt,
  };
}

export async function getPayoutAccountView(influencerId: string): Promise<PayoutAccountView | null> {
  const row = await prisma.payoutAccount.findUnique({ where: { influencerId } });
  return row ? toView(row) : null;
}

/**
 * Saves (creates or replaces) the influencer's payout details. Any change goes back to PENDING_REVIEW, so changed
 * details are never payable until an administrator verifies them again.
 */
export async function savePayoutAccount(influencerId: string, input: PayoutInput): Promise<PayoutAccountView> {
  const data =
    input.method === "BANK"
      ? {
          method: "BANK" as const,
          accountHolderName: input.accountHolderName,
          bankName: input.bankName,
          ifsc: input.ifsc,
          accountNumberEnc: encryptSecret(input.accountNumber, aad(influencerId, "account")),
          accountNumberMasked: maskAccountNumber(input.accountNumber),
          upiIdEnc: null,
          upiIdMasked: null,
        }
      : {
          method: "UPI" as const,
          accountHolderName: input.accountHolderName,
          bankName: null,
          ifsc: null,
          accountNumberEnc: null,
          accountNumberMasked: null,
          upiIdEnc: encryptSecret(input.upiId, aad(influencerId, "upi")),
          upiIdMasked: maskUpiId(input.upiId),
        };
  const review = { status: "PENDING_REVIEW" as const, rejectionReason: null, reviewedAt: null, reviewedByEmail: null };
  const row = await prisma.payoutAccount.upsert({
    where: { influencerId },
    create: { influencerId, ...data, ...review },
    update: { ...data, ...review },
  });
  return toView(row);
}

export interface RevealedPayoutAccount {
  method: "BANK" | "UPI";
  accountHolderName: string;
  bankName: string | null;
  ifsc: string | null;
  accountNumber: string | null;
  upiId: string | null;
  status: PayoutAccountView["status"];
}

/** The full details, for the administrator who is about to pay. Callers must write an audit entry first. */
export async function revealPayoutAccount(influencerId: string): Promise<RevealedPayoutAccount | null> {
  const row = await prisma.payoutAccount.findUnique({ where: { influencerId } });
  if (!row) return null;
  return {
    method: row.method,
    accountHolderName: row.accountHolderName,
    bankName: row.bankName,
    ifsc: row.ifsc,
    accountNumber: row.accountNumberEnc ? decryptSecret(row.accountNumberEnc, aad(influencerId, "account")) : null,
    upiId: row.upiIdEnc ? decryptSecret(row.upiIdEnc, aad(influencerId, "upi")) : null,
    status: row.status,
  };
}

/** Marks details verified or rejected. Only details currently awaiting review (or already verified) can be reviewed. */
export async function reviewPayoutAccount(
  influencerId: string,
  decision: { verified: true } | { verified: false; reason: string },
  reviewerEmail: string,
): Promise<PayoutAccountView | null> {
  const existing = await prisma.payoutAccount.findUnique({ where: { influencerId }, select: { id: true } });
  if (!existing) return null;
  const row = await prisma.payoutAccount.update({
    where: { influencerId },
    data: decision.verified
      ? { status: "VERIFIED", rejectionReason: null, reviewedAt: new Date(), reviewedByEmail: reviewerEmail }
      : { status: "REJECTED", rejectionReason: decision.reason.slice(0, 300), reviewedAt: new Date(), reviewedByEmail: reviewerEmail },
  });
  return toView(row);
}

/** True when the influencer has details an administrator has verified. */
export async function hasVerifiedPayoutAccount(influencerId: string): Promise<boolean> {
  const row = await prisma.payoutAccount.findUnique({ where: { influencerId }, select: { status: true } });
  return row?.status === "VERIFIED";
}
