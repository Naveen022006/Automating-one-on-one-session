import { NextResponse } from "next/server";
import { z } from "zod";

/** Parses and validates a JSON body. Returns the data, or a 400 response to send back. */
export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const raw = await req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Please check the highlighted fields.", details: z.flattenError(parsed.error) }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data };
}

export function jsonError(message: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Only same-site relative paths are allowed as post-login redirects (no open redirect). Control characters and
 * backslashes are rejected outright (browsers strip tabs/newlines and treat "\\" as "/", which turns "/\t/evil.com"
 * or "/\\evil.com" into a protocol-relative URL), and the result must resolve to this app's own origin.
 */
export function safeNextPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string" || next.length > 500) return fallback;
  if (!next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  const base = "https://app.invalid";
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function requestMeta(req: Request, ip: string): { userAgent: string | null; ip: string } {
  return { userAgent: req.headers.get("user-agent"), ip };
}
