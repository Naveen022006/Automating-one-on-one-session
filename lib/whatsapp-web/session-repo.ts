import { prisma } from "@/lib/db";
import type { AuthBlobStorage } from "./auth-state";

/**
 * Database access of the QR-code WhatsApp mode, behind an interface so the manager can be tested with an in-memory copy.
 * The columns written here are the worker's; the web app (commands.ts) writes only `wantLinked` and the consent. Writes are
 * targeted `updateMany`s on the influencer id (never a read-modify-write of the whole row), so the two sides do not overwrite each
 * other, and a row that was deleted meanwhile is simply not found.
 */

export type SessionStatus = "NOT_LINKED" | "PENDING_QR" | "LINKED" | "RECONNECTING" | "SUSPENDED" | "LOGGED_OUT";

/** A session row WITHOUT the stored login (which is only ever read through `authStorage`). */
export interface SessionRow {
  influencerId: string;
  status: SessionStatus;
  wantLinked: boolean;
  phoneE164: string | null;
  deviceLabel: string | null;
  consentAt: Date | null;
  consentVersion: string | null;
  linkedAt: Date | null;
  lastConnectedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  suspendedReason: string | null;
  consecutiveFailures: number;
  sentTotal: number;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionPatch = Partial<
  Pick<
    SessionRow,
    | "status" | "wantLinked" | "phoneE164" | "deviceLabel" | "consentAt" | "consentVersion" | "linkedAt" | "lastConnectedAt"
    | "lastErrorCode" | "lastErrorText" | "suspendedReason" | "consecutiveFailures"
  >
>;

export interface SessionRepo {
  /** Every session the manager has to look at: wanted ones, and ones still holding a link, a login or a suspension. */
  listManageable(): Promise<SessionRow[]>;
  get(influencerId: string): Promise<SessionRow | null>;
  update(influencerId: string, patch: SessionPatch): Promise<void>;
  incrementSent(influencerId: string): Promise<void>;
  /** Where the encrypted login of this influencer is stored. */
  authStorage(influencerId: string): AuthBlobStorage;
}

const SELECT = {
  influencerId: true,
  status: true,
  wantLinked: true,
  phoneE164: true,
  deviceLabel: true,
  consentAt: true,
  consentVersion: true,
  linkedAt: true,
  lastConnectedAt: true,
  lastErrorCode: true,
  lastErrorText: true,
  suspendedReason: true,
  consecutiveFailures: true,
  sentTotal: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const prismaSessionRepo: SessionRepo = {
  async listManageable() {
    return prisma.whatsAppWebSession.findMany({
      where: { OR: [{ wantLinked: true }, { status: { in: ["PENDING_QR", "LINKED", "RECONNECTING", "SUSPENDED"] } }] },
      select: SELECT,
      orderBy: { createdAt: "asc" },
    });
  },
  get(influencerId) {
    return prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: SELECT });
  },
  async update(influencerId, patch) {
    await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: patch });
  },
  async incrementSent(influencerId) {
    await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: { sentTotal: { increment: 1 } } });
  },
  authStorage(influencerId) {
    return {
      async load() {
        const row = await prisma.whatsAppWebSession.findUnique({ where: { influencerId }, select: { authStateEnc: true } });
        return row?.authStateEnc ?? null;
      },
      async save(sealed) {
        await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: { authStateEnc: sealed } });
      },
      async clear() {
        await prisma.whatsAppWebSession.updateMany({ where: { influencerId }, data: { authStateEnc: null } });
      },
    };
  },
};
