import { DEFAULT_GRAPH_VERSION } from "@/lib/whatsapp-graph-version";

/**
 * The Graph API version every server-side WhatsApp call uses. It reads the environment, so it lives apart from
 * `lib/whatsapp-graph-version.ts`, whose constant the browser imports. Server only. The base URL (Meta's host, or the local
 * mock) is NOT here: lib/provider-endpoints.ts is the single place that decides it.
 */

/** The configured version, or the default when WHATSAPP_GRAPH_VERSION is unset or is not of the form v26.0. */
export function graphVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.WHATSAPP_GRAPH_VERSION?.trim();
  return v && /^v\d+\.\d+$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
}
