import { reportError } from "../lib/observability";
import { describeError } from "../lib/whatsapp-web/safe";
import { scrubHealthText } from "../lib/views/admin-health";

/**
 * Process-level safety net of the worker, which carries every influencer's booking jobs (and, when switched on, the linked WhatsApp
 * sockets):
 *  - `unhandledRejection`: logged (one line with the error's name, and its stack), reported through `reportError` (the error webhook), and
 *    the worker KEEPS RUNNING. Without a handler Node ends the process on an unhandled rejection. Everything that leaves this function
 *    goes through `scrubLogText` first: the library's errors can carry a phone number, a message text or a token in their message;
 *  - a flood of them is a crash loop in disguise (something is rejecting over and over and nobody is awaiting it): after
 *    `REJECTION_LIMIT` within `REJECTION_WINDOW_MS` the process exits with code 1, so the supervisor restarts it and the restart is visible;
 *  - `uncaughtException`: logged through Node's monitor hook, which does NOT change what Node does afterwards: the process still exits (a
 *    program in an unknown state should not carry on handling money-related jobs). The supervisor restarts it.
 * Everything is injectable for the test.
 */

export const REJECTION_LIMIT = 10;
export const REJECTION_WINDOW_MS = 5 * 60_000;

/** The error text with secrets and phone numbers hidden: environment secrets, URL credentials, bearer tokens, token parameters, long digit runs. */
export function scrubLogText(text: string): string {
  return scrubHealthText(text)
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[number]")
    .replace(/\b\d{7,}(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us)\b/g, "[jid]");
}

/** An Error that is safe to hand to the reporter: the name, a scrubbed message and a scrubbed short stack. */
export function scrubbedError(reason: unknown): Error {
  const source = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "non-error rejection");
  const safe = new Error(scrubLogText(source.message));
  safe.name = source.name;
  safe.stack = scrubLogText((source.stack ?? "").split("\n").slice(0, 8).join("\n"));
  return safe;
}

export interface ProcessGuardOptions {
  log?: (line: string) => void;
  report?: (error: unknown, context: Record<string, unknown>) => void;
  exit?: (code: number) => void;
  now?: () => number;
  limit?: number;
  windowMs?: number;
}

export function installProcessGuards(proc: Pick<NodeJS.Process, "on" | "off"> = process, log: (line: string) => void = (l) => console.error(l), opts: Omit<ProcessGuardOptions, "log"> = {}): () => void {
  const report = opts.report ?? reportError;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? REJECTION_LIMIT;
  const windowMs = opts.windowMs ?? REJECTION_WINDOW_MS;
  const seen: number[] = [];
  let exiting = false;

  const onRejection = (reason: unknown) => {
    try {
      log(`[worker] unhandled promise rejection (${describeError(reason)}); continuing`);
      const safe = scrubbedError(reason);
      if (safe.stack) log(`[worker] ${safe.stack}`);
      report(safe, { where: "worker:unhandled-rejection" });
    } catch {
      /* the net itself must never throw */
    }
    const t = now();
    seen.push(t);
    while (seen.length > 0 && t - seen[0] > windowMs) seen.shift();
    if (seen.length >= limit && !exiting) {
      exiting = true;
      log(`[worker] ${seen.length} unhandled promise rejections within ${Math.round(windowMs / 60_000)} minutes; exiting so the supervisor restarts the worker`);
      exit(1);
    }
  };
  const onException = (error: unknown, origin: string) => {
    log(`[worker] uncaught exception (${describeError(error)}, ${String(origin).slice(0, 40)}); the process will exit`);
  };
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtExceptionMonitor", onException);
  return () => {
    proc.off("unhandledRejection", onRejection);
    proc.off("uncaughtExceptionMonitor", onException);
  };
}
