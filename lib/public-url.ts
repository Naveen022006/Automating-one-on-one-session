import { appUrl } from "@/lib/brand";

/**
 * An absolute URL on the PUBLIC origin (APP_URL) for a server-built redirect.
 *
 * Never derive a redirect target from the request URL inside a route handler: behind a container, a reverse proxy or a tunnel
 * Next reports the address it was bound to (`http://0.0.0.0:3000`), so `req.nextUrl.clone()` sent people to an address no browser
 * can reach (the Google connect/callback redirect did exactly that in production). The pathname, search and hash are set, not
 * parsed from a string, so the caller cannot smuggle in another origin.
 */
export function publicUrl(pathname: string, search = "", hash = ""): URL {
  const url = new URL(appUrl());
  url.pathname = pathname;
  url.search = search;
  url.hash = hash;
  return url;
}
