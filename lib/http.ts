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

// Moved to lib/safe-next-path.ts (pure, so the SPA's route guards use the very same open-redirect rules). Re-exported
// here so every existing server import keeps working.
export { safeNextPath } from "@/lib/safe-next-path";

export function requestMeta(req: Request, ip: string): { userAgent: string | null; ip: string } {
  return { userAgent: req.headers.get("user-agent"), ip };
}
