import type { Ctx, LatencyKind, Runtime } from "./http";

/**
 * Failure injection: what the owner (or a test) switches on to see the app's error handling. Every fault has a fixed set of
 * values; a value of "ok" (or the default) is no fault. `once` makes it apply to the next matching request only.
 */

export interface FaultDef {
  /** What it shows in the app. */
  help: string;
  /** The value when nothing is set. */
  default: string;
  /** Suggested values (the form offers them; any value matching `valid` is accepted). */
  options: string[];
  valid: RegExp;
}

const enumOf = (values: string[]) => new RegExp(`^(${values.join("|")})$`);

export const FAULTS: Record<string, FaultDef> = {
  "google.refresh": {
    help: "Token refresh: invalid_grant is a dead grant (the app shows Reconnect needed), invalid_client a configuration error (transient, retried), 500 Google being down.",
    default: "ok",
    options: ["ok", "invalid_grant", "invalid_client", "500"],
    valid: enumOf(["ok", "invalid_grant", "invalid_client", "500"]),
  },
  "google.code": {
    help: "OAuth code exchange (the connect callback): a failed exchange, or a grant that comes back without a refresh token.",
    default: "ok",
    options: ["ok", "invalid_grant", "no_refresh_token"],
    valid: enumOf(["ok", "invalid_grant", "no_refresh_token"]),
  },
  "google.calendar": {
    help: "Every Calendar call: 401 and a missing scope mean reconnect, accessNotConfigured and rate limits are transient (retried, then the influencer is alerted).",
    default: "ok",
    options: ["ok", "401", "403_accessNotConfigured", "403_insufficientPermissions", "403_rateLimitExceeded", "429", "500"],
    valid: enumOf(["ok", "401", "403_accessNotConfigured", "403_insufficientPermissions", "403_rateLimitExceeded", "429", "500"]),
  },
  "google.meet": {
    help: "How fast Google creates the Meet link: instant, ready 2 s after the insert, never (the app retries, then gives up), or a failed conference.",
    default: "instant",
    options: ["instant", "pending_2s", "pending_forever", "failure"],
    valid: enumOf(["instant", "pending_2s", "pending_forever", "failure"]),
  },
  "google.patch412": {
    help: "The next attendee change (If-Match) is answered 412 because 'someone else edited the event': the app must read it again and retry.",
    default: "ok",
    options: ["ok", "once"],
    valid: enumOf(["ok", "once"]),
  },
  "google.gmail": {
    help: "Gmail send: accessNotConfigured is the Gmail API not enabled on the Cloud project. The app falls back to the platform sender and shows 'Gmail not working'.",
    default: "ok",
    options: ["ok", "401", "403_accessNotConfigured", "403_insufficientPermissions", "429", "500"],
    valid: enumOf(["ok", "401", "403_accessNotConfigured", "403_insufficientPermissions", "429", "500"]),
  },
  "meta.send": {
    help: "Sending a WhatsApp message: 190 (token revoked) and 10 (permission) mark the connection Reconnect needed and the message goes by SMS.",
    default: "ok",
    options: ["ok", "190", "10", "500", "132001"],
    valid: enumOf(["ok", "190", "10", "500", "132001"]),
  },
  "meta.templates": {
    help: "Submitting message templates: the template sync fails (the card shows 'Could not submit').",
    default: "ok",
    options: ["ok", "10", "500"],
    valid: enumOf(["ok", "10", "500"]),
  },
  "meta.review": {
    help: "What Meta's review of a submitted template does: approve after N seconds, wait for you (the Meta page has the buttons), or reject with a reason. Real Meta takes minutes to 24 hours and may reject or change the category.",
    default: "auto:15",
    options: ["auto:15", "auto:0", "auto:60", "manual", "reject:INVALID_FORMAT", "reject:ABUSIVE_CONTENT"],
    valid: /^(auto:\d{1,4}|manual|reject:[A-Za-z_]{2,40}(:\d{1,4})?)$/,
  },
  "meta.status": {
    help: "The delivery statuses after a WhatsApp message is sent. Optional :<ms> sets the step (default 1000: sent after 1 step, delivered after 3, read after 8).",
    default: "delivered_read",
    options: ["delivered_read", "sent_only", "failed_131026", "instant", "out_of_order"],
    valid: /^(delivered_read|sent_only|failed_131026|instant|out_of_order)(:\d{1,5})?$/,
  },
  "meta.webhooks": {
    help: "Whether Meta's webhooks reach the app: off sends nothing (the 30-minute sync and 'Check template status' must pick things up), bad_signature breaks the signature, app_500_once makes the first delivery fail.",
    default: "on",
    options: ["on", "off", "bad_signature", "app_500_once"],
    valid: enumOf(["on", "off", "bad_signature", "app_500_once"]),
  },
  sms: {
    help: "The SMS sink answers 500: the SMS fallback fails and the message job retries (then the influencer is alerted).",
    default: "ok",
    options: ["ok", "500"],
    valid: enumOf(["ok", "500"]),
  },
  "latency.google": {
    help: "Delay for every Google call in ms. 16000 is past the app's 15 s timeout; reset closes the connection.",
    default: "0",
    options: ["0", "300", "2000", "16000", "reset"],
    valid: /^(\d{1,5}|reset)$/,
  },
  "latency.meta": {
    help: "Delay for every Meta Graph call in ms. 21000 is past the app's 20 s timeout; reset closes the connection.",
    default: "0",
    options: ["0", "300", "2000", "21000", "reset"],
    valid: /^(\d{1,5}|reset)$/,
  },
  "latency.sms": {
    help: "Delay for the SMS sink in ms (the app's timeout is 15 s); reset closes the connection.",
    default: "0",
    options: ["0", "300", "2000", "16000", "reset"],
    valid: /^(\d{1,5}|reset)$/,
  },
};

export class FaultError extends Error {}
/** Thrown after the connection was closed on purpose (latency fault "reset"): there is nothing left to answer. */
export class ConnectionResetError extends Error {}

/** Sets a fault. A value equal to the default clears it. Throws FaultError for an unknown key or a value it does not accept. */
export function setFault(rt: Runtime, key: string, value: string, once = false): void {
  const def = FAULTS[key];
  if (!def) throw new FaultError(`Unknown fault "${key}"`);
  if (!def.valid.test(value)) throw new FaultError(`"${value}" is not a value of ${key} (try: ${def.options.join(", ")})`);
  if (value === def.default) delete rt.state.faults[key];
  else rt.state.faults[key] = { value, once: once || key === "google.patch412" };
  rt.save();
  rt.activity(`Fault ${key} = ${value}${once ? " (once)" : ""}`);
}

export function clearFaults(rt: Runtime): void {
  rt.state.faults = {};
  rt.save();
  rt.activity("All faults cleared");
}

/** The value in force for `key` (the default when none is set). Does not consume a "once" fault. */
export function faultValue(rt: Runtime, key: string): string {
  return rt.state.faults[key]?.value ?? FAULTS[key]?.default ?? "ok";
}

/** The delay fault of a provider (latency.google, latency.meta, latency.sms), applied before its routes run. */
export async function applyLatency(c: Ctx, kind: LatencyKind): Promise<void> {
  const value = takeFault(c.rt, `latency.${kind}`, c);
  if (value === "0") return;
  if (value === "reset") {
    c.req.socket.destroy();
    throw new ConnectionResetError("connection reset on purpose (fault latency)");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Number(value)));
}

/**
 * The value in force, consuming a "once" fault: use it at the point where the fault applies. `c` (when given) records the
 * applied fault in the request log.
 */
export function takeFault(rt: Runtime, key: string, c?: Ctx): string {
  const set = rt.state.faults[key];
  const value = faultValue(rt, key);
  if (set) {
    if (c) c.note.fault = `${key}=${set.value}`;
    if (set.once) {
      delete rt.state.faults[key];
      rt.save();
    }
  }
  return value;
}
