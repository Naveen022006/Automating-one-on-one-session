import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyDashboardToken } from "@/lib/dashboard";
import { prisma } from "@/lib/db";

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
  const existing = await prisma.service.findFirst({ where: { id: body.serviceId, influencerId }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Service not found" }, { status: 404 });

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
