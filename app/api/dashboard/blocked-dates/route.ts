import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

// Block / unblock calendar days for the logged-in influencer. A blocked day produces no
// slots (see lib/slots.ts) and cannot be held. Every mutation requires a session first and that the blocked
// date belongs to that influencer (403/404).

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  date: z.string().regex(DATE),
  reason: z.string().trim().max(200).optional(),
});

const deleteSchema = z.object({
  // Accept either the row id or the date, so the UI can unblock by whichever it has.
  blockedDateId: z.string().min(1).optional(),
  date: z.string().regex(DATE).optional(),
});

/** A blocked day is stored at UTC midnight so it is tz-independent (see blockedDaySet in lib/slots.ts). */
function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function POST(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  const date = toUtcMidnight(parsed.data.date);
  if (Number.isNaN(date.getTime())) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  // Idempotent: the (influencer_id, date) unique constraint makes re-blocking the same day a no-op update.
  const row = await prisma.blockedDate.upsert({
    where: { influencerId_date: { influencerId, date } },
    create: { influencerId, date, reason: parsed.data.reason ?? null },
    update: { reason: parsed.data.reason ?? null },
    select: { id: true },
  });
  return NextResponse.json({ blockedDateId: row.id }, { status: 201 });
}

export async function DELETE(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.blockedDateId && !parsed.data.date)) {
    return NextResponse.json({ error: "Provide blockedDateId or date" }, { status: 400 });
  }

  const where = parsed.data.blockedDateId
    ? { id: parsed.data.blockedDateId, influencerId }
    : { influencerId, date: toUtcMidnight(parsed.data.date!) };
  const existing = await prisma.blockedDate.findFirst({ where, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Blocked date not found" }, { status: 404 });

  await prisma.blockedDate.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true });
}
