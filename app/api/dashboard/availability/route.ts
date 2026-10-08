import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyDashboardToken } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { isValidTimezone } from "@/lib/slots";

// Create / update / delete weekly availability rules for the influencer the dashboard token authorises.
// Every mutation verifies the token first and that the rule belongs to that influencer (403/404).

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const createSchema = z.object({
  token: z.string().min(1),
  weekday: z.number().int().min(1).max(7), // ISO: 1=Mon ... 7=Sun
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
  timezone: z.string().min(1),
});

const updateSchema = z.object({
  token: z.string().min(1),
  ruleId: z.string().min(1),
  weekday: z.number().int().min(1).max(7).optional(),
  startTime: z.string().regex(TIME).optional(),
  endTime: z.string().regex(TIME).optional(),
  timezone: z.string().min(1).optional(),
});

const deleteSchema = z.object({ token: z.string().min(1), ruleId: z.string().min(1) });

export async function POST(req: Request) {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

  const body = parsed.data;
  if (!isValidTimezone(body.timezone)) return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  if (body.endTime <= body.startTime) {
    return NextResponse.json({ error: "endTime must be after startTime" }, { status: 400 });
  }

  const rule = await prisma.availabilityRule.create({
    data: {
      influencerId,
      weekday: body.weekday,
      startTime: body.startTime,
      endTime: body.endTime,
      timezone: body.timezone,
    },
    select: { id: true },
  });
  return NextResponse.json({ ruleId: rule.id }, { status: 201 });
}

export async function PATCH(req: Request) {
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

  const body = parsed.data;
  const existing = await prisma.availabilityRule.findFirst({
    where: { id: body.ruleId, influencerId },
  });
  if (!existing) return NextResponse.json({ error: "Availability rule not found" }, { status: 404 });

  const timezone = body.timezone ?? existing.timezone;
  if (!isValidTimezone(timezone)) return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  const startTime = body.startTime ?? existing.startTime;
  const endTime = body.endTime ?? existing.endTime;
  if (endTime <= startTime) return NextResponse.json({ error: "endTime must be after startTime" }, { status: 400 });

  await prisma.availabilityRule.update({
    where: { id: existing.id },
    data: { weekday: body.weekday ?? existing.weekday, startTime, endTime, timezone },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }
  const influencerId = verifyDashboardToken(parsed.data.token);
  if (!influencerId) return NextResponse.json({ error: "Invalid or expired dashboard link" }, { status: 403 });

  const existing = await prisma.availabilityRule.findFirst({
    where: { id: parsed.data.ruleId, influencerId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Availability rule not found" }, { status: 404 });

  await prisma.availabilityRule.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true });
}
