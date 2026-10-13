import { BRAND_NAME } from "@/lib/brand";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { clientHeadFor, formatTitle, type ClientHead, type SpaTitleTemplate } from "@/lib/spa/routes";

/**
 * Sets the document title. React 19 hoists a `<title>` rendered anywhere into `<head>`, and puts it BEFORE the title the
 * server wrote into the shell, so the page's own title wins.
 *
 * RULES (they follow from how the hoisting works):
 *   1. Render exactly ONE <PageTitle> per page, in the page component (a layout must not add a default title: when a
 *      layout and its page both render one, the layout's wins, because parents mount last).
 *   2. Give it the same title and template as the route's row in lib/spa/routes.ts, so the title does not flicker when
 *      React takes over from the server-rendered head: `<PageTitle title="Sessions" template="dashboard" />`.
 *   3. Render it while the page's data is still loading too, not only after it arrives (use a neutral title until then).
 */
export function PageTitle({ title, template = "brand" }: { title: string; template?: SpaTitleTemplate }) {
  return <title>{formatTitle(title, template, BRAND_NAME)}</title>;
}

/** Removes the tag matching `selector` and, when `attrs` is given, writes a fresh one (tags the server wrote are replaced too). */
function setTag(doc: Document, tag: "meta" | "link", selector: string, attrs: Record<string, string> | null): void {
  doc.head.querySelectorAll(selector).forEach((el) => el.remove());
  if (!attrs) return;
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  doc.head.appendChild(el);
}

/** Writes description, canonical, robots and the share card into the document head (QA-3). Exported for tests. */
export function applyClientHead(doc: Document, head: ClientHead): void {
  setTag(doc, "meta", 'meta[name="description"]', head.description ? { name: "description", content: head.description } : null);
  setTag(doc, "link", 'link[rel="canonical"]', head.canonical ? { rel: "canonical", href: head.canonical } : null);
  const robots = head.robots === "index" ? null : head.robots === "noindex" ? "noindex" : "noindex, nofollow";
  setTag(doc, "meta", 'meta[name="robots"]', robots ? { name: "robots", content: robots } : null);
  doc.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((el) => el.remove());
  const s = head.share;
  if (!s) return;
  const add = (k: "property" | "name", key: string, content: string) => {
    const el = doc.createElement("meta");
    el.setAttribute(k, key);
    el.setAttribute("content", content);
    doc.head.appendChild(el);
  };
  add("property", "og:type", "website");
  add("property", "og:title", s.title);
  add("property", "og:description", s.description);
  if (s.url) add("property", "og:url", s.url);
  add("name", "twitter:card", "summary");
  add("name", "twitter:title", s.title);
  add("name", "twitter:description", s.description);
}

/**
 * Keeps the head tags in step with the URL after an in-app navigation (the title follows through <PageTitle>). The first
 * render is skipped: the server already wrote the exact head for that URL. Mounted once, in RootLayout.
 */
export function RouteHead() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    applyClientHead(document, clientHeadFor(pathname, window.location.origin, BRAND_NAME));
  }, [pathname]);
  return null;
}
