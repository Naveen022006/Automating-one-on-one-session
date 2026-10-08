import { NextResponse } from "next/server";
import { isSlugAvailable } from "@/lib/auth/accounts";
import { getAuth } from "@/lib/auth/session";
import { slugProblem } from "@/lib/auth/slug";

// GET /api/auth/slug-available?slug=priya -> { available, problem }. Used by register and settings.
export async function GET(req: Request) {
  const slug = (new URL(req.url).searchParams.get("slug") ?? "").trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return NextResponse.json({ available: false, problem });
  const auth = await getAuth();
  const available = await isSlugAvailable(slug, auth?.influencerId);
  return NextResponse.json({ available, problem: available ? null : "This address is taken." });
}
