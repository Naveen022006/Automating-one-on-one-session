import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildAuthUrl } from "@/lib/google";
import { CONNECT_LINK_PURPOSE, NONCE_COOKIE, OAUTH_STATE_PURPOSE } from "@/lib/google-tokens";
import { randomNonce, signToken, verifyToken } from "@/lib/signing";

const STATE_TTL_SEC = 600;

// Step 1 of the connect flow. Reached through a signed link (see buildConnectUrl), never by influencer id alone.
export async function GET(req: NextRequest) {
  const link = verifyToken<{ i: string }>(CONNECT_LINK_PURPOSE, req.nextUrl.searchParams.get("t"));
  if (!link) {
    return NextResponse.json({ error: "This connect link is invalid or has expired" }, { status: 403 });
  }
  const influencer = await prisma.influencer.findUnique({ where: { id: link.i }, select: { id: true } });
  if (!influencer) return NextResponse.json({ error: "Influencer not found" }, { status: 404 });

  // `state` is signed (so it cannot be forged) and carries a nonce that must match this browser's cookie
  // on the way back, so a callback URL cannot be replayed into a different person's session.
  const nonce = randomNonce();
  const state = signToken(OAUTH_STATE_PURPOSE, { i: influencer.id, n: nonce }, STATE_TTL_SEC);

  const res = NextResponse.redirect(buildAuthUrl(state));
  res.cookies.set(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax", // must be sent on the top-level redirect back from accounts.google.com
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
    path: "/api/google",
    maxAge: STATE_TTL_SEC,
  });
  return res;
}
