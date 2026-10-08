import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";
import { SUPPORT_EMAIL } from "@/lib/brand";

export const metadata: Metadata = { title: "Refund and Cancellation Policy", alternates: { canonical: "/refund-policy" } };

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund and Cancellation Policy" updated="October 2026">
      <p>
        Every service shows its cancellation policy on the booking page before you pay. One of these three applies:
      </p>
      <ul>
        <li><strong>Flexible:</strong> cancel any time before the session for a full refund.</li>
        <li><strong>24-hour notice:</strong> cancel at least 24 hours before the session for a full refund; later cancellations are not refunded.</li>
        <li><strong>Non-refundable:</strong> no refund if you cancel.</li>
      </ul>
      <h2>If the host cancels</h2>
      <p>You are always refunded in full, whatever the policy.</p>
      <h2>Rescheduling</h2>
      <p>You can move your booking to another open time from the link in your confirmation email, at no cost.</p>
      <h2>How refunds are paid</h2>
      <p>
        Refunds go back to the original payment method through Razorpay. Banks usually take 5 to 7 working days to show
        the money.
      </p>
      <h2>Problems with a payment</h2>
      <p>
        If money left your account but you did not receive a confirmation, write to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with your booking reference. A payment that could not be
        matched to a booking is refunded.
      </p>
    </LegalPage>
  );
}
