/**
 * Client IP for rate limiting. Next.js does not expose the socket address, so the IP comes from a header set by
 * the platform in front of the app, and only from headers a client cannot forge:
 *
 *   - CLIENT_IP_HEADER (recommended in production): the ONE header your platform sets, e.g. "cf-connecting-ip"
 *     behind Cloudflare or "x-real-ip" / "x-forwarded-for" on Vercel. It is trusted exclusively. For
 *     x-forwarded-for the right-most entry is used (the one appended by your own proxy).
 *   - Unset: the right-most X-Forwarded-For entry, which is appended by the proxy directly in front of the app;
 *     anything a client puts in the header ends up to its left and is ignored. Client-settable headers such as
 *     cf-connecting-ip or x-real-ip are NOT trusted by default, because without that platform in front a client
 *     could send a new value on every request and get a fresh rate-limit bucket each time.
 *
 * IPv6 addresses are reduced to their /64 prefix, because one subscriber usually controls a whole /64.
 */
let warned = false;

export function clientIp(headers: Headers): string {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const name = configured || "x-forwarded-for";
  const raw = headers.get(name);
  if (raw) {
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    const pick = name === "x-forwarded-for" ? parts[parts.length - 1] : parts[0];
    if (pick) return normaliseIp(pick);
  }
  if (!warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn(`[rate-limit] no client IP in "${name}"; all such requests share one bucket. Set CLIENT_IP_HEADER.`);
  }
  return "unknown";
}

export function normaliseIp(ip: string): string {
  // Strip an IPv4-mapped IPv6 prefix and any port on a bare IPv4 address.
  let v = ip.trim();
  if (v.startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.split(":")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  if (!v.includes(":")) return v.slice(0, 64);
  const hextets = expandIpv6(v.split("%")[0]);
  if (!hextets) return v.slice(0, 64);
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

function expandIpv6(ip: string): string[] | null {
  const parts = ip.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (parts.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array(parts.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/i.test(h))) return null;
  return all.map((h) => h.toLowerCase().replace(/^0+(?=.)/, ""));
}
