import { APP_COUNTRY, APP_LOCALE_DEFAULT } from "@/lib/india";
import { DEFAULT_DESCRIPTION, decodeSpaParam, formatTitle, type SpaMatch, type SpaRobots } from "./routes";

/**
 * Server-side <head> for the SPA's HTML shell (doc/10-react-migration-plan.md, section 3): the status code, title,
 * robots, canonical, Open Graph and JSON-LD that crawlers and link-preview bots read from the INITIAL html, before (or
 * without) any JavaScript. SERVER ONLY (it is not on the web bundle's allowlist), but free of database and filesystem
 * imports on purpose: the profile lookup is injected (`HeadContext.loadProfile`), so tests need no database.
 *
 * Every piece of text that reaches the HTML goes through escapeHtml(). Profile names and bios are written by
 * influencers, so they are untrusted input in a security-sensitive place; never build markup around them any other way.
 */

/** `& < > " '` escaped, for text nodes AND attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

export type ShellStatus = 200 | 404 | 503;

/** The few profile fields the head needs (a subset of PublicProfile, so the real loader is assignable). */
export interface ProfileHeadData {
  slug: string;
  name: string;
  bio: string | null;
  /** The viewer is the owner looking at a page that is not live yet: never index it. */
  preview: boolean;
}

export interface HeadContext {
  /** APP_URL without a trailing slash. */
  appUrl: string;
  brand: string;
  supportEmail: string;
  /** NODE_ENV !== production, or ENABLE_DESIGN_PAGE=true. */
  designEnabled: boolean;
  /** `loadPublicProfile` in production. null = no such (visible) profile; a thrown error = the lookup failed. */
  loadProfile: (slug: string) => Promise<ProfileHeadData | null>;
}

export interface ShellHead {
  status: ShellStatus;
  /** The final document title (template already applied). */
  title: string;
  description?: string;
  /** Absolute URL. */
  canonical?: string;
  robots: SpaRobots;
  noReferrer: boolean;
  /** Open Graph and Twitter card. Only indexable pages have one; private screens do not need a preview. */
  share?: { title: string; description: string; image: string; imageAlt: string; url?: string };
  jsonLd?: Record<string, unknown>;
  /** Seconds, for the Retry-After header on a 503. */
  retryAfterSec?: number;
}

/** Open Graph writes a locale with an underscore: en-IN -> en_IN. */
const OG_LOCALE = APP_LOCALE_DEFAULT.replace("-", "_");
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

function shareFor(ctx: HeadContext, title: string, description: string, url?: string): NonNullable<ShellHead["share"]> {
  return {
    title,
    description,
    image: `${ctx.appUrl}/opengraph-image`,
    imageAlt: `${ctx.brand}: paid sessions with automatic Google Meet links`,
    url,
  };
}

function notFoundHead(ctx: HeadContext, template: "brand" | "dashboard" | "admin" = "brand"): ShellHead {
  return { status: 404, title: formatTitle("Not found", template, ctx.brand), robots: template === "brand" ? "noindex" : "noindex,nofollow", noReferrer: false };
}

/**
 * Status and head for a matched route. Never throws: a failing profile lookup becomes a 503 head, which the route
 * answers with Retry-After (the SPA then boots and shows its own error state).
 */
export async function resolveHead(match: SpaMatch, ctx: HeadContext): Promise<ShellHead> {
  const { route } = match;
  // The "not found" routes (unknown URL, unknown dashboard/admin path) are real 404s, with the title template of their area.
  if (match.status === 404) return notFoundHead(ctx, route.template === "dashboard" || route.template === "admin" ? route.template : "brand");
  const base = (title: string): string => formatTitle(title, route.template, ctx.brand);
  const canonical = "canonical" in route && route.canonical ? `${ctx.appUrl}${route.path === "/" ? "/" : route.path}` : undefined;

  switch (route.head) {
    case "landing": {
      const title = base(route.title);
      return {
        status: 200,
        title,
        description: DEFAULT_DESCRIPTION,
        canonical,
        robots: route.robots,
        noReferrer: false,
        share: shareFor(ctx, title, DEFAULT_DESCRIPTION, canonical),
        jsonLd: {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: ctx.brand,
          url: ctx.appUrl,
          email: ctx.supportEmail,
          // India only (doc/14-india-localisation.md): who it serves and in which language.
          areaServed: APP_COUNTRY,
          knowsLanguage: APP_LOCALE_DEFAULT,
        },
      };
    }
    case "design": {
      if (!ctx.designEnabled) return notFoundHead(ctx);
      return { status: 200, title: base(route.title), robots: route.robots, noReferrer: false };
    }
    case "profile":
    case "book": {
      const slug = decodeSpaParam(match.params.slug ?? "");
      let profile: ProfileHeadData | null;
      try {
        profile = await ctx.loadProfile(slug);
      } catch {
        // A database problem must not turn into a "this profile does not exist" that crawlers remember.
        return { status: 503, title: formatTitle("Temporarily unavailable", "brand", ctx.brand), robots: "noindex", noReferrer: false, retryAfterSec: 30 };
      }
      if (!profile) return notFoundHead(ctx);
      const isBook = route.head === "book";
      const title = base(isBook ? `Book ${profile.name}` : `Book a session with ${profile.name}`);
      const description = isBook ? DEFAULT_DESCRIPTION : (profile.bio?.slice(0, 160) || `Book a paid 1:1 or group session with ${profile.name}.`);
      const url = `${ctx.appUrl}/${profile.slug}${isBook ? "/book" : ""}`;
      return {
        status: 200,
        title,
        description,
        canonical: url,
        robots: profile.preview ? "noindex" : "index",
        noReferrer: false,
        share: profile.preview ? undefined : shareFor(ctx, title, description, url),
      };
    }
    case "static": {
      const title = base(route.title ?? "");
      const description = "description" in route && route.description ? route.description : route.robots === "index" ? DEFAULT_DESCRIPTION : undefined;
      return {
        status: 200,
        title,
        description,
        canonical,
        robots: route.robots,
        noReferrer: "noReferrer" in route && route.noReferrer === true,
        share: route.robots === "index" && description ? shareFor(ctx, title, description, canonical) : undefined,
      };
    }
  }
}

/** The value for `<meta name="robots">` and for the X-Robots-Tag header; null for pages that may be indexed. */
export function robotsDirective(robots: SpaRobots): string | null {
  return robots === "index" ? null : robots === "noindex" ? "noindex" : "noindex, nofollow";
}

/** JSON for a `<script type="application/ld+json">`: `<` is escaped so no value can close the script or open a comment. */
export function jsonLdText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * The head tags as one HTML string, inserted at `<!--spa-head-->` in the template. `nonce` is the request's CSP nonce
 * (the JSON-LD block gets it for symmetry with the rest of the shell).
 */
export function renderHead(head: ShellHead, brand: string, nonce: string): string {
  const out: string[] = [];
  const meta = (attrs: string) => out.push(`<meta ${attrs}>`);
  out.push(`<title>${escapeHtml(head.title)}</title>`);
  meta(`name="application-name" content="${escapeHtml(brand)}"`);
  if (head.description) meta(`name="description" content="${escapeHtml(head.description)}"`);
  if (head.canonical) out.push(`<link rel="canonical" href="${escapeHtml(head.canonical)}">`);
  const robots = robotsDirective(head.robots);
  if (robots) meta(`name="robots" content="${robots}"`);
  if (head.noReferrer) meta(`name="referrer" content="no-referrer"`);
  if (head.share) {
    const s = head.share;
    meta(`property="og:type" content="website"`);
    meta(`property="og:locale" content="${OG_LOCALE}"`);
    meta(`property="og:site_name" content="${escapeHtml(brand)}"`);
    meta(`property="og:title" content="${escapeHtml(s.title)}"`);
    meta(`property="og:description" content="${escapeHtml(s.description)}"`);
    if (s.url) meta(`property="og:url" content="${escapeHtml(s.url)}"`);
    meta(`property="og:image" content="${escapeHtml(s.image)}"`);
    meta(`property="og:image:width" content="${OG_IMAGE_WIDTH}"`);
    meta(`property="og:image:height" content="${OG_IMAGE_HEIGHT}"`);
    meta(`property="og:image:alt" content="${escapeHtml(s.imageAlt)}"`);
    meta(`name="twitter:card" content="summary_large_image"`);
    meta(`name="twitter:title" content="${escapeHtml(s.title)}"`);
    meta(`name="twitter:description" content="${escapeHtml(s.description)}"`);
    meta(`name="twitter:image" content="${escapeHtml(s.image)}"`);
  }
  if (head.jsonLd) out.push(`<script type="application/ld+json" nonce="${escapeHtml(nonce)}">${jsonLdText(head.jsonLd)}</script>`);
  return out.join("\n    ");
}
