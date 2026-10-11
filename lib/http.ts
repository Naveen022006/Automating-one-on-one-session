import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * True when a decoded JSON value holds a NUL character (U+0000) in any string or object key. Postgres cannot store one in text: the
 * query fails and the request ends in a 500. A NUL is never legitimate input, so it is refused with the rest of the invalid input.
 */
export function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\u0000")) return true;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v !== null && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) {
        if (k.includes("\u0000")) return true;
        stack.push(item);
      }
    }
  }
  return false;
}

/**
 * Reads a JSON request body: the parsed value, or null when the body is not JSON or holds a NUL character anywhere. The one place the
 * routes read their body, so a `\u0000` in any field of the hold, checkout, manage, auth, dashboard or admin routes is a 400 like any
 * other invalid input instead of a database error (use it instead of `req.json().catch(() => null)`).
 */
export async function readJson(req: Request): Promise<unknown> {
  const raw = await req.json().catch(() => null);
  return containsNul(raw) ? null : raw;
}

/**
 * The shape of an id this app creates (Prisma cuid, e.g. `cmuzpfpa80006hgvwwv85s7c7`): letters, digits, `_` and `-`, at most 64. Check
 * an id taken from a URL or a body with this BEFORE it reaches a query.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isEntityId(value: string | null | undefined): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Parses and validates a JSON body. Returns the data, or a 400 response to send back. */
export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const raw = await readJson(req);
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

// Moved to lib/safe-next-path.ts (pure, so the SPA's route guards use the very same open-redirect rules). Re-exported
// here so every existing server import keeps working.
export { safeNextPath } from "@/lib/safe-next-path";

export function requestMeta(req: Request, ip: string): { userAgent: string | null; ip: string } {
  return { userAgent: req.headers.get("user-agent"), ip };
}
