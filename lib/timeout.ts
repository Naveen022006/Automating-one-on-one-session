/**
 * How long a caller that holds a database transaction waits for a job to be queued before giving up and rolling back
 * (the queue connection retries forever while Redis is down).
 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Rejects if `work` has not settled within `ms`. The underlying work is NOT cancelled (a Redis command waiting on a
 * dead connection keeps waiting), so callers use this to stop *themselves* waiting, never to undo anything.
 */
export function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
