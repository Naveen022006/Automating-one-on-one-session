import { LegalPage } from "@web/components/site/LegalPage";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/lib/brand";

/** The Terms of Service text. The only copy of the text. */
export function TermsView() {
  return (
    <LegalPage title="Terms of Service" updated="October 2026">
      <p>
        These terms govern the use of {BRAND_NAME} by creators (&ldquo;hosts&rdquo;) who sell sessions, and by customers who
        book them. By creating an account or booking a session you agree to them.
      </p>
      <h2>1. The service</h2>
      <p>
        {BRAND_NAME} lets hosts publish a booking page, take payments through Razorpay, and deliver Google Meet links and
        reminders by WhatsApp, SMS and email. The host, not {BRAND_NAME}, provides the session itself and is responsible
        for its content.
      </p>
      <h2>2. Host accounts</h2>
      <ul>
        <li>You must give accurate information and keep your password secure.</li>
        <li>You are responsible for your services, prices, availability and cancellation policy.</li>
        <li>You must connect a Google account you control; meetings are created on that account&rsquo;s calendar.</li>
        <li>You must not use the service for unlawful content or to message people who have not opted in.</li>
      </ul>
      <h2>3. Bookings and payments</h2>
      <p>
        A booking is confirmed only when Razorpay confirms the payment. Prices are shown before payment, including the
        currency. Payment processing is subject to Razorpay&rsquo;s terms.
      </p>
      <h2>4. Cancellations and refunds</h2>
      <p>
        Each service states its cancellation policy. If a host cancels, the customer is refunded in full. See the{" "}
        <a href="/refund-policy">Refund and Cancellation Policy</a>.
      </p>
      <h2>5. Messages</h2>
      <p>
        Customers who opt in receive their meeting link and reminders on WhatsApp, with SMS as a fallback, and by email.
        These are transactional messages about their booking.
      </p>
      <h2>6. Availability and liability</h2>
      <p>
        We work to keep the service available but cannot guarantee uninterrupted operation of third-party services
        (Razorpay, Google, WhatsApp, SMS and email providers). To the extent permitted by law, our liability is limited to
        the fees paid to us for the affected booking.
      </p>
      <h2>7. Termination</h2>
      <p>You may close your account at any time. We may suspend accounts that breach these terms.</p>
      <h2>8. Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
