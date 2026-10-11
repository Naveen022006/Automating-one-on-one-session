import { NextResponse, type NextRequest } from "next/server";
import { BRAND_NAME, SUPPORT_EMAIL, appUrl } from "@/lib/brand";
import { loadPublicProfile } from "@/lib/public-profile";
import { renderHead, resolveHead, robotsDirective } from "@/lib/spa/head";
import { matchSpaRoute } from "@/lib/spa/routes";
import { ShellTemplateError, loadShellTemplate, renderShell } from "@/lib/spa/shell";

/**
 * The HTML shell of the React SPA (doc/12-front-end.md).
 *
 * NOT a public URL. proxy.ts rewrites every page path to `/spa-shell/<original path>`, handing this handler the
 * per-request CSP nonce in the `x-nonce` request header, and answers 404 itself to any direct request for
 * `/spa-shell...`. This handler repeats the check (no `x-nonce` => 404), so even if the proxy matcher were changed
 * the shell would never be rendered without a nonce, i.e. never as an unusable blank page and never with a
 * client-chosen one.
 *
 * What it does: resolve the route from the table (lib/spa/routes.ts), build the status and <head> for it
 * (lib/spa/head.ts: title, robots, canonical, Open Graph, JSON-LD, and for profile pages a real 404 when the profile does
 * not exist), and render the Vite-built index.html with the nonce in every tag (lib/spa/shell.ts).
 */
export const dynamic = "force-dynamic";

const PREFIX = "/spa-shell";
let templateErrorLogged = false;

function plain(status: number, body: string): NextResponse {
  return new NextResponse(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const nonce = req.headers.get("x-nonce");
  if (!nonce) return plain(404, "Not found");

  // A request that carries Next's RSC / prefetch headers (a stale tab from before the Next pages were removed, or a crawler
  // replaying one) is not a page load. Next strips its flight headers from the request the PROXY sees, so the proxy cannot
  // tell; this handler can. Answer with an empty 204 (no profile lookup, no template): a non-RSC answer makes Next's client
  // fall back to a normal full page load, which then requests this URL again WITHOUT the header and gets the real shell.
  if (req.headers.get("rsc") !== null || req.headers.get("next-router-prefetch") !== null) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // The proxy rewrites "/x" to "/spa-shell/x" (and "/" to "/spa-shell"). Depending on how Next reports a rewritten request,
  // `nextUrl.pathname` is the original path ("/x") or the rewritten one ("/spa-shell/x"); accept both and recover "/x".
  const raw = req.nextUrl.pathname;
  const pathname = raw === PREFIX ? "/" : raw.startsWith(`${PREFIX}/`) ? raw.slice(PREFIX.length) : raw;
  const match = matchSpaRoute(pathname);
  if (!match) return plain(404, "Not found");

  let template: string;
  try {
    template = loadShellTemplate();
  } catch (e) {
    // One line per process, not per request: this is a deployment mistake (the image lacks web/dist/index.html), and
    // the production start-up check (lib/env.ts) normally refuses to boot in that state.
    if (!templateErrorLogged) {
      templateErrorLogged = true;
      console.error(`[spa-shell] ${e instanceof ShellTemplateError ? e.message : "cannot read the shell template"}`);
    }
    return plain(500, "Internal error");
  }

  const head = await resolveHead(match, {
    appUrl: appUrl(),
    brand: BRAND_NAME,
    supportEmail: SUPPORT_EMAIL,
    designEnabled: process.env.NODE_ENV !== "production" || process.env.ENABLE_DESIGN_PAGE === "true",
    loadProfile: loadPublicProfile,
  });

  const html = renderShell(template, {
    nonce,
    headHtml: renderHead(head, BRAND_NAME, nonce),
    supportEmail: SUPPORT_EMAIL,
  });

  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    // The page depends on the session (owner preview), the status on the database; never cache the shell anywhere.
    "cache-control": "no-store",
  };
  const robots = robotsDirective(head.robots);
  if (robots) headers["x-robots-tag"] = robots;
  // Token URLs (/manage, /verify-email, /reset-password): the token must not leak through a Referer header to anything
  // the page links or loads. NOTE: the Referrer-Policy from next.config.ts' security headers replaces whatever a route
  // handler sets, so the header that actually reaches the browser is set by proxy.ts; this one and the <meta name="referrer">
  // in the head are the fallbacks (for example if the config headers are ever restructured).
  if (head.noReferrer) headers["referrer-policy"] = "no-referrer";
  if (head.retryAfterSec) headers["retry-after"] = String(head.retryAfterSec);
  return new NextResponse(html, { status: head.status, headers });
}

export async function HEAD(req: NextRequest): Promise<NextResponse> {
  const res = await GET(req);
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
