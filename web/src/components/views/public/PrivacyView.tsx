import { LegalPage } from "@web/components/site/LegalPage";
import { AppLink } from "@web/lib/link";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/lib/brand";

/** The Privacy Policy text. The only copy of the text. */
export function PrivacyView() {
  return (
    <LegalPage title="Privacy Policy" updated="October 2026">
      <p>This policy explains what personal data {BRAND_NAME} processes, why, and the choices you have.</p>
      <h2>Data we process</h2>
      <h3>Customers (people who book a session)</h3>
      <ul>
        <li>Name, email address and WhatsApp number, to confirm the booking and send the meeting link and reminders.</li>
        <li>Your time zone, so times are shown correctly.</li>
        <li>Payment status and reference from Razorpay. We never see or store card details.</li>
        <li>Delivery status of messages sent to you (sent, delivered, read, failed).</li>
      </ul>
      <h3>Hosts (creators with an account)</h3>
      <ul>
        <li>Name, email, profile details and a hashed password (we cannot read your password).</li>
        <li>An encrypted Google refresh token and the Google account email, to create calendar events with Meet links.</li>
        <li>Sign-in records (time, browser, IP address) to secure your account.</li>
      </ul>
      <h2>WhatsApp linked by QR code (optional)</h2>
      <p>
        A host can choose to link their own WhatsApp number to the service as a linked device, by scanning a QR code, instead of using the
        official WhatsApp Business connection. This is an unofficial method and WhatsApp may restrict or ban the number. For it we store an
        encrypted login for the linked device (so it stays connected), the linked phone number, the device name, when and in which version the
        host accepted the risks, and counts of messages sent. WhatsApp&rsquo;s encryption also keeps small technical records for each contact
        inside that login, named after the contact&rsquo;s phone number (no message text); we remove a customer&rsquo;s records when their
        data is erased and, regularly, for customers who no longer have a booking with that host. Messages are sent only about a booking that a customer made with that host,
        from the host&rsquo;s number through WhatsApp. We do not read or store customers&rsquo; replies or the host&rsquo;s chats. When the
        host disconnects, we delete the stored login; the device should also be removed in WhatsApp under Linked devices.
      </p>
      <h2>Who we share it with</h2>
      <p>
        Only the providers needed to deliver the service: Razorpay (payments), Google (calendar and Meet), Meta (WhatsApp),
        our SMS provider, our email provider, and our hosting and database providers. The host you book with can see your
        booking details.
      </p>
      <h2>Retention</h2>
      <p>
        Booking contact details are kept while needed to deliver and support the session and for accounting afterwards.
        Customers can ask the host, or us, to erase their details; payment records are kept as required by law with the
        personal details removed. Expired sign-in sessions and single-use links are deleted automatically.
      </p>
      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, a correction, or erasure. Write to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We reply within 30 days.
      </p>
      <p>
        Customers can also do this themselves, without an account: <AppLink href="/bookings">find your bookings</AppLink> with the e-mail
        address you booked with, then see them, download a copy of the data we hold under that address, or erase it. Erasing removes your
        name, e-mail address, phone number, time zone and booking answers from past bookings with every host. Payment records are kept
        without your personal details, because the law requires them for accounting, and an upcoming session keeps its details until it
        is cancelled, so that it can still take place.
      </p>
      <h2>Security</h2>
      <p>
        Data is sent over HTTPS. Passwords are hashed, Google tokens are encrypted at rest, sign-in endpoints are rate
        limited, and access to a host&rsquo;s data requires that host&rsquo;s login.
      </p>
      <h2>Cookies</h2>
      <p>
        We use one essential cookie to keep hosts signed in, and a short-lived cookie during the Google connection step. We
        do not use advertising or tracking cookies.
      </p>
    </LegalPage>
  );
}
