/**
 * The Meta Graph API version every WhatsApp call uses (templates, sending, token checks, the Facebook SDK in the sign-up
 * window). One place, because Meta retires old versions on a schedule: set WHATSAPP_GRAPH_VERSION (for example v27.0) to
 * move without a code change. Meta publishes the current versions and their end dates at
 * https://developers.facebook.com/docs/graph-api/changelog/versions.
 *
 * Kept free of imports so the settings card in the browser can use it too.
 */

/** v26.0 was released on 2026-07-29 (v21.0, the previous default, is retired by Meta on 2027-01-21). */
export const DEFAULT_GRAPH_VERSION = "v26.0";

/** The configured version, or the default when WHATSAPP_GRAPH_VERSION is unset or is not of the form v26.0. */
export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.WHATSAPP_GRAPH_VERSION?.trim();
  return v && /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}
