import { loadPublicProfile } from "@/lib/public-profile";
import { jsonView } from "@/lib/views/http";

export const dynamic = "force-dynamic";

/**
 * An influencer's public booking page for the SPA (`/:slug` and `/:slug/book`): `loadPublicProfile`
 * pages and the shell's <head> use, so the three cannot disagree. A page that is not live answers 404 to everyone except
 * its signed-in owner, who gets it with `preview: true` and the list of what is still missing (the session cookie is read
 * in `loadPublicProfile`). No email, id or connection detail is part of the profile.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  if (!profile) return jsonView({ error: "Not found" }, { status: 404 });
  return jsonView(profile);
}
