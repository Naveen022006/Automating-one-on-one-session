import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyDashboardToken } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { activeSeatWhere } from "@/lib/holds";

// Influencer-authenticated via the signed dashboard token (same purpose as the dashboard page). Every mutation
// verifies the token first and that the targeted service belongs to that influencer; otherwise 403/404. Request
// bodies are validated with zod and named errors are mapped to status, matching app/api/checkout/route.ts and
// app/api/bookings/hold/route.ts.

const createSchema = z.object({
  token: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  durationMin: z.number().int().positive().max(24 * 60),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().trim().length(3).optional(),
  type: z.enum(["ONE_TO_ONE", "GROUP"]).optional(),
  capacity: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
});

const updateSchema = z.object({
  token: z.string().min(1),
  serviceId: z.string().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  durationMin: z.number().int().positive().max(24 * 60).optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  type: z.enum(["ONE_TO_ONE", "GROUP"]).optional(),
  capacity: z.number().int().positive().max(1000).optional(),
  active: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

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
    },
    select: { id: true },
  });
  return NextResponse.json({ serviceId: service.id }, { status: 201 });
}

export async function PATCH(req: Request) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

  const body = parsed.data;
  // Ownership check: the service must belong to this influencer, else 404.
  const existing = await prisma.service.findFirst({
    where: { id: body.serviceId, influencerId },
    select: { id: true, type: true, capacity: true },
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
    },
  });
  return NextResponse.json({ ok: true });
}
