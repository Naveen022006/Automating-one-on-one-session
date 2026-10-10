/**
 * Next.js start-up hook: runs once per server process, before the first request.
 *
 * It validates the environment (lib/env.ts). In production a bad configuration prints ONE aggregated, secret-free
 * message and exits with code 1. Exiting matters: if register() merely threw, Next.js would keep the server up and
 * fail every request with the same error, flooding the logs and leaving the container running but broken. A process
 * that exits is a failed rollout that every platform understands (crash loop, health check never passes). In
 * development the same problems are printed as warnings and the server starts.
 */
export async function register() {
  // Only the Node.js server runtime (not the edge runtime), and never while `next build` is collecting page data
  // (a build machine does not have, and must not need, the production secrets).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { initEnvOrExit } = await import("./lib/env");
  initEnvOrExit("web");
}
