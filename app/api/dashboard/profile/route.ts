import { NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { isSlugAvailable, isUniqueViolation } from "@/lib/auth/accounts";
import { requireApiAuth } from "@/lib/auth/session";
import { slugProblem } from "@/lib/auth/slug";
import { prisma } from "@/lib/db";
import { jsonError, parseJson } from "@/lib/http";
import { isValidTimezone } from "@/lib/slots";

const schema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  // A link to an image the influencer already hosts (there is no file upload storage yet). https only.
  photoUrl: z.union([z.url({ protocol: /^https$/ }).max(500), z.literal("")]).nullable().optional(),
  timezone: z.string().max(64).optional(),
  slug: z.string().trim().toLowerCase().max(60).optional(),
  notifyByEmail: z.boolean().optional(),
});

// Profile, public slug, timezone and notification preferences of the logged-in influencer.
export async function PATCH(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const parsed = await parseJson(req, schema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (body.timezone !== undefined && !isValidTimezone(body.timezone)) return jsonError("Choose a valid timezone.", 400, { field: "timezone" });
  if (body.slug !== undefined && body.slug !== auth.influencerSlug) {
    const problem = slugProblem(body.slug);
    if (problem) return jsonError(problem, 400, { field: "slug" });
    if (!(await isSlugAvailable(body.slug, auth.influencerId))) return jsonError("This address is taken.", 409, { field: "slug" });
  }

  // The values before the change, only to tell which fields changed for the activity log (a failed read changes nothing).
  const previous = await prisma.influencer
    .findUnique({ where: { id: auth.influencerId }, select: { name: true, bio: true, photoUrl: true, timezone: true, notifyByEmail: true } })
    .catch(() => null);

  try {
    await prisma.influencer.update({
      where: { id: auth.influencerId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.bio !== undefined ? { bio: body.bio || null } : {}),
        ...(body.photoUrl !== undefined ? { photoUrl: body.photoUrl || null } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.notifyByEmail !== undefined ? { notifyByEmail: body.notifyByEmail } : {}),
      },
    });
  } catch (e) {
    // Another influencer claimed the same slug between the availability check and this update.
    if (isUniqueViolation(e)) return jsonError("This address was just taken.", 409, { field: "slug" });
    throw e;
  }
  const slugChanged = body.slug !== undefined && body.slug !== auth.influencerSlug;
  const changed = [
    body.name !== undefined && body.name !== previous?.name ? "name" : null,
    body.bio !== undefined && (body.bio || null) !== (previous?.bio ?? null) ? "bio" : null,
    body.photoUrl !== undefined && (body.photoUrl || null) !== (previous?.photoUrl ?? null) ? "photoUrl" : null,
    body.timezone !== undefined && body.timezone !== previous?.timezone ? "timezone" : null,
    slugChanged ? "slug" : null,
    body.notifyByEmail !== undefined && body.notifyByEmail !== previous?.notifyByEmail ? "notifyByEmail" : null,
  ].filter((f): f is string => f !== null);
  if (changed.length > 0) {
    await recordActivity({
      influencerId: auth.influencerId,
      action: "profile.updated",
      detail: { fields: changed.join(","), ...(slugChanged ? { slugFrom: auth.influencerSlug, slugTo: body.slug! } : {}) },
      req,
    });
  }
  return NextResponse.json({ ok: true });
}
