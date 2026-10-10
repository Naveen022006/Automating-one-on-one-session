import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export interface AuditActor {
  adminId: string | null;
  email: string;
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Appends one row to the admin audit trail. Awaited by callers that move money or reveal sensitive data, so an
 * action never happens without a record: if this throws, the caller should not proceed (or should roll back).
 * Never put secrets (bank numbers, passwords) in `detail`; record what was done and to which record.
 */
export async function recordAudit(
  actor: AuditActor,
  entry: AuditEntry,
  /** Pass a transaction client to write the entry inside the caller's transaction. */
  db: { adminAuditLog: Pick<typeof prisma.adminAuditLog, "create"> } = prisma,
): Promise<void> {
  await db.adminAuditLog.create({
    data: {
      adminId: actor.adminId,
      adminEmail: actor.email,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail,
      ip: entry.ip?.slice(0, 64),
    },
  });
}

/** Failed sign-in attempts carry no admin id; record the email that was tried. */
export async function recordAnonymousAudit(email: string, entry: AuditEntry): Promise<void> {
  await recordAudit({ adminId: null, email: email.slice(0, 200) }, entry);
}
