import { describeError } from "../lib/whatsapp-web/safe";

/**
 * Process-level safety net of the worker, which carries every influencer's booking jobs (and, when switched on, the linked WhatsApp
 * sockets):
 *  - `unhandledRejection`: one log line, no secrets (the error's name only), and the worker KEEPS RUNNING. Without a handler Node
 *    ends the process on an unhandled rejection;
 *  - `uncaughtException`: logged through Node's monitor hook, which does NOT change what Node does afterwards: the process still
 *    exits (a program in an unknown state should not carry on handling money-related jobs). The supervisor restarts it.
 * `proc` and `log` are injectable for the test.
 */
export function installProcessGuards(proc: Pick<NodeJS.Process, "on" | "off"> = process, log: (line: string) => void = (l) => console.error(l)): () => void {
  const onRejection = (reason: unknown) => {
    log(`[worker] unhandled promise rejection (${describeError(reason)}); continuing`);
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
