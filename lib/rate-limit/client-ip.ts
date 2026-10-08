/**
 * Best-effort client IP from request headers. Next.js does not expose the socket address, so the IP comes from
 * the headers set by the platform in front of the app:
 *   - CLIENT_IP_HEADER (if set) is trusted exclusively, e.g. "cf-connecting-ip" behind Cloudflare or
 *     "x-real-ip" on Vercel. Set this in production so a client cannot spoof its IP with a forged header.
 *   - otherwise: cf-connecting-ip, x-real-ip, then the FIRST x-forwarded-for entry.
 * IPv6 addresses are reduced to their /64 prefix, because one subscriber usually controls a whole /64 and could
 * otherwise rotate addresses to dodge limits.
 */
export function clientIp(headers: Headers): string {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  const candidates = configured ? [configured] : ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"];
  for (const name of candidates) {
    const raw = headers.get(name);
    if (!raw) continue;
    const first = raw.split(",")[0]?.trim();
    if (first) return normaliseIp(first);
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
