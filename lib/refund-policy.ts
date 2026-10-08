/** Pure cancellation refund rules (no database), shared by the cancel flow, the manage page and tests. */

/** Who cancelled. An influencer-initiated cancel always refunds in full; a customer cancel follows the service policy. */
export type CancelActor = "customer" | "influencer";
export type RefundPolicy = "FULL" | "NOTICE_24H" | "NONE";

export const NOTICE_MS = 24 * 3_600_000;

/** Pure: is this cancellation eligible for a refund, and why. */
export function refundDecision(args: {
  policy: RefundPolicy;
  actor: CancelActor;
  sessionStart: Date;
  now?: Date;
}): { refund: boolean; reason: string } {
  const now = args.now ?? new Date();
  if (args.actor === "influencer") return { refund: true, reason: "cancelled by the host" };
  switch (args.policy) {
    case "FULL":
      return { refund: true, reason: "cancelled by the customer (full refund policy)" };
    case "NONE":
      return { refund: false, reason: "cancelled by the customer (no-refund policy)" };
    case "NOTICE_24H": {
      const early = args.sessionStart.getTime() - now.getTime() >= NOTICE_MS;
      return early
        ? { refund: true, reason: "cancelled by the customer at least 24 hours ahead" }
        : { refund: false, reason: "cancelled by the customer less than 24 hours ahead (no refund)" };
    }
  }
}

/** Customer-facing explanation of a policy, shown on the booking page and the manage page. */
export function describeRefundPolicy(policy: RefundPolicy): string {
  switch (policy) {
    case "FULL":
      return "Cancel any time before the session for a full refund.";
    case "NOTICE_24H":
      return "Cancel at least 24 hours before the session for a full refund. Later cancellations are not refunded.";
    case "NONE":
      return "This session is non-refundable if you cancel. If the host cancels, you are refunded in full.";
  }
}
