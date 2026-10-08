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

/** Only same-site relative paths are allowed as post-login redirects (no open redirect). */
export function safeNextPath(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next.slice(0, 500);
}

export function requestMeta(req: Request, ip: string): { userAgent: string | null; ip: string } {
  return { userAgent: req.headers.get("user-agent"), ip };
}
