import { NextResponse } from "next/server";
import { readJson } from "@/lib/http";
import { z } from "zod";
import { requireApiAuth } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { isValidTimezone } from "@/lib/slots";
import { loadAvailabilityView } from "@/lib/views/dashboard-availability";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

// Create / update / delete weekly availability rules for the logged-in influencer. Every mutation requires a
// session (401) and that the rule belongs to that influencer (404).

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const createSchema = z.object({
  weekday: z.number().int().min(1).max(7), // ISO: 1=Mon ... 7=Sun
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
  timezone: z.string().min(1),
});

const updateSchema = z.object({
  ruleId: z.string().min(1),
  weekday: z.number().int().min(1).max(7).optional(),
  startTime: z.string().regex(TIME).optional(),
  endTime: z.string().regex(TIME).optional(),
  timezone: z.string().min(1).optional(),
});

const deleteSchema = z.object({ ruleId: z.string().min(1) });

// The Availability page's data for the SPA (the old Next page renders from the same loadAvailabilityView): the
// influencer's time zone, weekly rules and blocked days.
export async function GET() {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  return jsonView(await loadAvailabilityView(auth.influencerId));
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
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = updateSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

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
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const influencerId = auth.influencerId;
  const parsed = deleteSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: z.flattenError(parsed.error) }, { status: 400 });
  }

  const existing = await prisma.availabilityRule.findFirst({
    where: { id: parsed.data.ruleId, influencerId },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: "Availability rule not found" }, { status: 404 });

  await prisma.availabilityRule.delete({ where: { id: existing.id } });
  return NextResponse.json({ ok: true });
}
