import { NextResponse } from "next/server";
import { readJson } from "@/lib/http";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { MAX_ADVANCE_DAYS, MAX_NOTICE_HOURS } from "@/lib/booking-window";
import { activeSeatWhere } from "@/lib/holds";
import { intakeQuestionsInput } from "@/lib/intake";
import { loadServicesView } from "@/lib/views/dashboard-services";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// Influencer-authenticated via the login session (lib/auth/session.ts). Every mutation requires a session first
// and that the targeted service belongs to that influencer; otherwise 401/404. Request
// bodies are validated with zod and named errors are mapped to status, matching app/api/checkout/route.ts and
// app/api/bookings/hold/route.ts.

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  durationMin: z.number().int().positive().max(24 * 60),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().trim().length(3).optional(),
  type: z.enum(["ONE_TO_ONE", "GROUP"]).optional(),
  capacity: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
  refundPolicy: z.enum(["FULL", "NOTICE_24H", "NONE"]).optional(),
  intakeQuestions: intakeQuestionsInput.optional(),
  minNoticeHours: z.number().int().min(0).max(MAX_NOTICE_HOURS).optional(),
  maxAdvanceDays: z.number().int().min(1).max(MAX_ADVANCE_DAYS).optional(),
  prepNotes: z.string().trim().max(1000).nullable().optional(),
  requiresApproval: z.boolean().optional(),
});

const updateSchema = z.object({
  serviceId: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMin: z.number().int().positive().max(24 * 60).optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  type: z.enum(["ONE_TO_ONE", "GROUP"]).optional(),
  capacity: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
  refundPolicy: z.enum(["FULL", "NOTICE_24H", "NONE"]).optional(),
  intakeQuestions: intakeQuestionsInput.optional(),
  minNoticeHours: z.number().int().min(0).max(MAX_NOTICE_HOURS).optional(),
  maxAdvanceDays: z.number().int().min(1).max(MAX_ADVANCE_DAYS).optional(),
  prepNotes: z.string().trim().max(1000).nullable().optional(),
  requiresApproval: z.boolean().optional(),
});

/**
 * Free Gmail accounts end group Google Meet calls (3+ participants) at 60 minutes. Returned as a warning (not an
 * error) because Google Workspace accounts do not have the limit.
 */
function meetLimitWarning(type: string | undefined, durationMin: number | undefined): string | null {
  return type === "GROUP" && (durationMin ?? 0) > 60
    ? "Free Gmail accounts end group Meet calls after 60 minutes. Use a Google Workspace account or keep group sessions to 60 minutes."
    : null;
}

// The Services page's data for the SPA (the old Next page renders from the same loadServicesView): this influencer's
// services only, hidden ones included.
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadServicesView(auth.influencerId));
}

export async function POST(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = createSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  const body = parsed.data;
  const type = body.type ?? "ONE_TO_ONE";
  // A 1:1 service holds a single seat; a group's capacity must be explicit (default to 2 to be a real group).
  const capacity = type === "GROUP" ? body.capacity ?? 2 : 1;

  const service = await prisma.service.create({
    data: {
      influencerId,
      title: body.title,
      description: body.description ?? null,
      durationMin: body.durationMin,
      priceMinor: body.priceMinor,
      currency: body.currency ?? "INR",
      type,
      capacity,
      active: body.active ?? true,
      refundPolicy: body.refundPolicy ?? "FULL",
      ...(body.intakeQuestions ? { intakeQuestions: body.intakeQuestions } : {}),
      ...(body.minNoticeHours !== undefined ? { minNoticeHours: body.minNoticeHours } : {}),
      ...(body.maxAdvanceDays !== undefined ? { maxAdvanceDays: body.maxAdvanceDays } : {}),
      prepNotes: body.prepNotes || null,
      requiresApproval: body.requiresApproval ?? false,
    },
    select: { id: true },
  });
  return NextResponse.json({ serviceId: service.id, warning: meetLimitWarning(type, body.durationMin) }, { status: 201 });
}

export async function PATCH(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = updateSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  const body = parsed.data;
  // Ownership check: the service must belong to this influencer, else 404.
  const existing = await prisma.service.findFirst({
    where: { id: body.serviceId, influencerId },
    select: { id: true, type: true, capacity: true, durationMin: true },
  });
  if (!existing) return NextResponse.json({ error: "Service not found" }, { status: 404 });

  // The hold path (lib/holds.ts) and the shared-group-event path (lib/meeting.ts) both read the CURRENT
  // service.capacity/type and assume they cannot retroactively invalidate seats already sold. So a capacity
  // shrink below the seats already taken on a live session, or a type flip while sessions already exist, would
  // break that invariant (a previously-valid group would look oversold, and in-flight bookings would switch
  // event-id scheme). Guard both before applying any change.
  const changingType = body.type !== undefined && body.type !== existing.type;
  const loweringCapacity = body.capacity !== undefined && body.capacity < existing.capacity;

  if (changingType || loweringCapacity) {
    const now = new Date();
    // Max active seats across all of this service's sessions. A session with no live bookings is harmless.
    const sessions = await prisma.session.findMany({
      where: { serviceId: existing.id },
      select: { id: true, _count: { select: { bookings: { where: activeSeatWhere(now) } } } },
    });
    const liveSessions = sessions.filter((s) => s._count.bookings > 0);
    const maxActiveSeats = liveSessions.reduce((m, s) => Math.max(m, s._count.bookings), 0);

    if (changingType && liveSessions.length > 0) {
      return NextResponse.json(
        { error: "Cannot change the service type while it has sessions with live bookings" },
        { status: 409 },
      );
    }
    if (loweringCapacity && body.capacity! < maxActiveSeats) {
      return NextResponse.json(
        { error: `Capacity cannot be lowered below ${maxActiveSeats}; that many seats are already booked on a session` },
        { status: 409 },
      );
    }
  }

  await prisma.service.update({
    where: { id: existing.id },
    data: {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.durationMin !== undefined ? { durationMin: body.durationMin } : {}),
      ...(body.priceMinor !== undefined ? { priceMinor: body.priceMinor } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.refundPolicy !== undefined ? { refundPolicy: body.refundPolicy } : {}),
      // An empty list clears the questions (stored as JSON null); existing bookings keep their answers regardless.
      ...(body.intakeQuestions !== undefined ? { intakeQuestions: body.intakeQuestions.length ? body.intakeQuestions : Prisma.DbNull } : {}),
      ...(body.minNoticeHours !== undefined ? { minNoticeHours: body.minNoticeHours } : {}),
      ...(body.maxAdvanceDays !== undefined ? { maxAdvanceDays: body.maxAdvanceDays } : {}),
      ...(body.prepNotes !== undefined ? { prepNotes: body.prepNotes || null } : {}),
      ...(body.requiresApproval !== undefined ? { requiresApproval: body.requiresApproval } : {}),
    },
  });
  return NextResponse.json({
    ok: true,
    warning: meetLimitWarning(body.type ?? existing.type, body.durationMin ?? existing.durationMin),
  });
}
