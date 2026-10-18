import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sendAccountEmail } from "@/lib/email";
import { platformEmailEnabled } from "@/lib/email/providers";
import { passwordChangedMessage, passwordResetMessage, verifyEmailMessage } from "@/lib/email/templates";
import { dummyPasswordHash, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";
import { revokeAllSessions } from "./session";
import { slugProblem, suggestSlug } from "./slug";
import { hashToken, randomToken } from "./tokens";

export class AccountError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Start of a password-reset token created by an administrator (see createPasswordResetLink). */
export const ADMIN_RESET_PREFIX = "adm.";
export const VERIFY_TTL_MS = 24 * 3_600_000;
export const RESET_TTL_MS = 3_600_000;

/** Prisma's unique-constraint error (P2002), without importing the generated client's error classes. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** First free slug based on `base` (base, base-2, base-3...). */
export async function availableSlug(base: string): Promise<string> {
  const root = slugProblem(base) ? suggestSlug(base) : base;
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? root : `${root.slice(0, 36)}-${i}`;
    if (slugProblem(candidate)) continue;
    const taken = await prisma.influencer.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${root.slice(0, 30)}-${randomToken().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

export async function isSlugAvailable(slug: string, exceptInfluencerId?: string): Promise<boolean> {
  const row = await prisma.influencer.findUnique({ where: { slug }, select: { id: true } });
  return !row || row.id === exceptInfluencerId;
}

/**
 * Creates a verification link and e-mails it. Returns whether an e-mail went out. With EMAIL_PROVIDER=none (doc/15) there is no one to
 * send it to: nothing is created (an administrator verifies the account by hand, POST /api/admin/influencers/:id/verify-email).
 */
async function issueVerification(userId: string, email: string, name: string): Promise<boolean> {
  if (!platformEmailEnabled()) return false;
  const token = randomToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  return sendAccountEmail(
    { email, name },
    verifyEmailMessage(name, `${appUrl()}/verify-email?token=${encodeURIComponent(token)}`),
    "verify-email",
  );
}

/**
 * Creates the user and their influencer profile, then emails a verification link. The slug is validated and
 * must be free; the email must not already have an account (or be an existing influencer profile owned by
 * someone else).
 */
export async function registerAccount(input: {
  name: string;
  email: string;
  password: string;
  slug: string;
  timezone: string;
  acceptTerms: boolean;
}): Promise<{ userId: string }> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (!input.acceptTerms) throw new AccountError("Please accept the Terms and Privacy Policy.", "acceptTerms");
  const pw = passwordProblem(input.password, { email, name });
  if (pw) throw new AccountError(pw, "password");
  const slug = input.slug.trim().toLowerCase();
  const sp = slugProblem(slug);
  if (sp) throw new AccountError(sp, "slug");

  const [existingUser, existingInfluencer, slugOwner] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.influencer.findUnique({ where: { email }, select: { id: true, user: { select: { id: true } } } }),
    prisma.influencer.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  // Same message whether the email has an account or not would be friendlier for privacy, but registration has to
  // tell the person to log in instead; the endpoint is rate limited per IP to slow down enumeration.
  if (existingUser || existingInfluencer?.user) {
    throw new AccountError("An account with this email already exists. Log in or reset your password.", "email", 409);
  }
  if (existingInfluencer) {
    // An influencer profile created before accounts existed (seeded by hand). Claiming it requires proving
    // ownership of the email, which registration + verification does; but we must not let a stranger take it
    // over before verification, so it is refused here and handled manually.
    throw new AccountError("This email belongs to an existing creator profile. Contact support to claim it.", "email", 409);
  }
  if (slugOwner) throw new AccountError("This booking page address is taken. Please choose another.", "slug", 409);

  const passwordHash = await hashPassword(input.password);
  let user: { id: string };
  try {
    user = await prisma.$transaction(async (tx) => {
      const influencer = await tx.influencer.create({
        data: { slug, name, email, timezone: input.timezone, onboardedAt: null },
        select: { id: true },
      });
      return tx.user.create({
        data: { email, passwordHash, termsAcceptedAt: new Date(), influencerId: influencer.id },
        select: { id: true },
      });
    });
  } catch (e) {
    // Two registrations racing for the same email or slug: the unique index decides; report it as a conflict.
    if (isUniqueViolation(e)) throw new AccountError("That email or booking page address was just taken. Please try again.", undefined, 409);
    throw e;
  }

  await issueVerification(user.id, email, name);
  return { userId: user.id };
}

/**
 * Checks credentials. Always runs one password hash comparison (against a dummy hash for unknown emails) so the
 * response time does not reveal which emails have accounts.
 */
export async function authenticate(emailInput: string, password: string): Promise<{ userId: string } | null> {
  const email = normaliseEmail(emailInput);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } });
  if (!user) {
    await verifyPassword(password, await dummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  if (needsRehash(user.passwordHash)) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } }).catch(() => {});
  }
  return { userId: user.id };
}

/** Sends a new verification link. Returns whether an e-mail went out (false: already verified, or the platform sends no e-mail). */
export async function resendVerification(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true, influencer: { select: { name: true } } },
  });
  if (!user || user.emailVerifiedAt) return false;
  return issueVerification(user.id, user.email, user.influencer.name);
}

/** Consumes a verification token. Returns the user id, or null when the token is invalid, used or expired. */
export async function verifyEmailToken(token: string): Promise<string | null> {
  const row = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) return null;
  const claimed = await prisma.emailVerificationToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return null;
  await prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  return row.userId;
}

/**
 * Starts a password reset. Silent for unknown emails (the API always answers the same way), so it cannot be
 * used to discover which emails have accounts.
 */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  // With EMAIL_PROVIDER=none (doc/15) nobody can receive the link, and creating one would only cancel the link an administrator may
  // have handed over (only the newest link is valid). So it does nothing; the page tells the person to ask their administrator.
  if (!platformEmailEnabled()) return;
  const email = normaliseEmail(emailInput);
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, influencer: { select: { name: true } } },
  });
  if (!user) return;
  const { url } = await createPasswordResetLink(user.id);
  await sendAccountEmail({ email, name: user.influencer.name }, passwordResetMessage(user.influencer.name, url), "password-reset");
}

/**
 * Creates a one-time password-reset link (valid RESET_TTL_MS, only the newest link stays valid) and returns its full URL. The token is
 * stored only as its SHA-256. The URL is the caller's to deliver: the reset e-mail, or an administrator handing it over by hand
 * (POST /api/admin/influencers/:id/reset-link). Never log it. `db` lets the caller create it inside its own transaction.
 */
export async function createPasswordResetLink(
  userId: string,
  db: Pick<typeof prisma, "passwordResetToken"> = prisma,
  opts: { createdByAdmin?: boolean } = {},
): Promise<{ url: string; expiresAt: Date }> {
  // Only the newest link is valid.
  await db.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  // A link an administrator hands over proves nothing about the mailbox, so using it must not verify the e-mail address (resetPassword does
  // that only for a link e-mailed to the address). The table has no column for the difference and a migration is not worth it: the
  // marker is a prefix of the token itself. Self-requested tokens are base64url and never contain a ".", and the marker is only read
  // from a token whose hash is stored, so nobody can add or remove it from a token they were given.
  const token = opts.createdByAdmin ? `${ADMIN_RESET_PREFIX}${randomToken()}` : randomToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await db.passwordResetToken.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  return { url: `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`, expiresAt };
}

/** Completes a reset: sets the new password, marks the email verified (they proved access), logs out everywhere. */
export async function resetPassword(token: string, newPassword: string): Promise<{ userId: string }> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, emailVerifiedAt: true, influencer: { select: { name: true } } } } },
  });
  if (!row || row.usedAt || row.expiresAt <= new Date()) {
    throw new AccountError("This reset link is invalid or has expired. Request a new one.", "token");
  }
  const pw = passwordProblem(newPassword, { email: row.user.email, name: row.user.influencer.name });
  if (pw) throw new AccountError(pw, "password");

  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw new AccountError("This reset link was already used.", "token");

  await prisma.user.update({
    where: { id: row.userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      passwordChangedAt: new Date(),
      // Setting a password through a link e-mailed to the address proves control of the mailbox. A link an administrator handed over
      // proves nothing about it, so it leaves the verification state exactly as it was.
      ...(token.startsWith(ADMIN_RESET_PREFIX) ? {} : { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() }),
    },
  });
  await revokeAllSessions(row.userId);
  await sendAccountEmail({ email: row.user.email, name: row.user.influencer.name }, passwordChangedMessage(row.user.influencer.name), "password-changed");
  return { userId: row.userId };
}

/** Changes the password of a logged-in user (current password required) and logs out every other session. */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true, influencer: { select: { name: true } } },
  });
  if (!user) throw new AccountError("Account not found", undefined, 404);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AccountError("Your current password is not correct.", "currentPassword");
  }
  const pw = passwordProblem(newPassword, { email: user.email, name: user.influencer.name });
  if (pw) throw new AccountError(pw, "newPassword");
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
  });
  // Outstanding reset links must not be able to undo the change.
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  await revokeAllSessions(user.id, currentSessionId);
  await sendAccountEmail({ email: user.email, name: user.influencer.name }, passwordChangedMessage(user.influencer.name), "password-changed");
}
