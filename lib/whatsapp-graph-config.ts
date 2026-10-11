import { DEFAULT_GRAPH_VERSION } from "@/lib/whatsapp-graph-version";

/**
 * The Graph API version and base URL every server-side WhatsApp call uses. These read the environment, so they live
 * apart from `lib/whatsapp-graph-version.ts`, whose constant the browser imports. Server only.
 */

/** The configured version, or the default when WHATSAPP_GRAPH_VERSION is unset or is not of the form v26.0. */
export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.WHATSAPP_GRAPH_VERSION?.trim();
  return v && /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}

/** The base URL of every Graph call. */
export function graphBase(env: Record<string, string | undefined> = process.env): string {
  return `https://graph.facebook.com/${graphVersion(env)}`;
}
