import type { WhatsAppWebTransportEvents } from "./transport";

/**
 * Containment for the third-party WhatsApp library: an error thrown (or a promise rejected) inside one of its callbacks, or inside
 * one of ours that it calls, must end up as a log line and nothing else. An unhandled rejection or an exception thrown from an event
 * emitter would otherwise reach the process, and the worker also carries the booking jobs of every influencer.
 *
 * Only the name of an error (and a numeric status code when it has one) is ever passed on: a library error can carry a phone number,
 * a message text or key material in its message.
 */

/** "TypeError", or "Boom (statusCode 428)". Never the message. */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const status = (e as { output?: { statusCode?: unknown } }).output?.statusCode;
    return typeof status === "number" ? `${e.name} (status ${status})` : e.name;
  }
  return typeof e;
}

/**
 * Wraps a callback so that neither a throw nor a rejection can escape it. `onError` receives the error (and must not throw; if it does
 * the failure is swallowed too). The wrapper returns nothing: the library ignores what its callbacks answer.
 */
export function safely<A extends unknown[]>(fn: (...args: A) => unknown, onError: (e: unknown) => void): (...args: A) => void {
  const report = (e: unknown) => {
    try {
      onError(e);
    } catch {
      /* a broken logger is not a reason to crash */
    }
  };
  return (...args: A) => {
    try {
      const out = fn(...args);
      if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") (out as Promise<unknown>).then(undefined, report);
    } catch (e) {
      report(e);
    }
  };
}

/** The transport events the manager gave us, each wrapped with `safely`. */
export function safeEvents(events: WhatsAppWebTransportEvents, onError: (e: unknown) => void): WhatsAppWebTransportEvents {
  return {
    onQr: safely(events.onQr.bind(events), onError),
    onOpen: safely(events.onOpen.bind(events), onError),
    onClose: safely(events.onClose.bind(events), onError),
    onDelivery: safely(events.onDelivery.bind(events), onError),
  };
}
