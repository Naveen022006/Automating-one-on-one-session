import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth, requireRecentAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";

// Lists the user's signed-in devices, and revokes one of them.
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.authSession.findMany({
    where: { userId: auth.userId, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, createdAt: true, lastUsedAt: true, userAgent: true, ip: true },
  });
  return NextResponse.json({ sessions: rows.map((r) => ({ ...r, current: r.id === auth.sessionId })) });
}

const deleteSchema = z.object({ sessionId: z.string().min(1).max(64) });

export async function DELETE(req: Request) {
  const auth = await requireRecentAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, deleteSchema);
  if (!parsed.ok) return parsed.response;
  const { count } = await prisma.authSession.deleteMany({ where: { id: parsed.data.sessionId, userId: auth.userId } });
  if (count === 0) return jsonError("Session not found", 404);
  return NextResponse.json({ ok: true });
}
