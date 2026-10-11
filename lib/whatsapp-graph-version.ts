/**
 * The default Meta Graph API version every WhatsApp call uses (templates, sending, token checks, the Facebook SDK in the sign-up
 * window). One place, because Meta retires old versions on a schedule: set WHATSAPP_GRAPH_VERSION (for example v27.0) to
 * move without a code change; the code that reads that variable is `lib/whatsapp-graph-config.ts`. Meta publishes the
 * current versions and their end dates at https://developers.facebook.com/docs/graph-api/changelog/versions.
 *
 * Kept free of imports AND of environment access, because the WhatsApp settings card in the browser imports it (it is on
 * the browser allowlist in web/vite-server-guard.ts).
 */

/** v26.0 was released on 2026-07-29 (v21.0, the previous default, is retired by Meta on 2027-01-21). */
export const DEFAULT_GRAPH_VERSION = "v26.0";
