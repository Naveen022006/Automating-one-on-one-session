/**
 * Error reporting for the web app and the worker. Always writes one structured JSON line (easy to search in any
 * log drain). If ERROR_WEBHOOK_URL is set, the same payload is POSTed there too (Slack/Discord-compatible
 * `text` field included), which gives real-time error notifications without adding an SDK dependency. To use
 * Sentry, install @sentry/nextjs and call Sentry.captureException from `setErrorReporter`.
 */

export type ErrorReporter = (error: unknown, context: Record<string, unknown>) => void;

function serialise(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack?.split("\n").slice(0, 8).join("\n") };
  return { message: String(error) };
}

const defaultReporter: ErrorReporter = (error, context) => {
  const payload = { level: "error", at: new Date().toISOString(), ...context, error: serialise(error) };
  console.error(JSON.stringify(payload));
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `[${context.where ?? "app"}] ${payload.error.message}`, ...payload }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
};

let reporter: ErrorReporter = defaultReporter;
export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

/**
 * A non-exception notification (system health alert, "recovered" note) through the same channel as errors: one
 * structured JSON log line, plus the ERROR_WEBHOOK_URL POST (Slack/Discord-compatible `text`). Not routed through
 * `setErrorReporter`, because it is not an error. Never throws.
 */
export function reportNotice(level: "warn" | "info", text: string, context: Record<string, unknown> = {}): void {
  try {
    const payload = { level, at: new Date().toISOString(), ...context, message: text };
    (level === "warn" ? console.warn : console.info)(JSON.stringify(payload));
    const url = process.env.ERROR_WEBHOOK_URL;
    if (!url) return;
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...payload }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  } catch {
    /* reporting must never break the caller */
  }
}

/** Never throws. */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  try {
    reporter(error, context);
  } catch {
    /* reporting must never break the caller */
  }
}
