import { IconCheck } from "@/components/icons";
import { BookingFragment, DashboardFragment, RemindersFragment, WhatsAppFragment } from "@/components/site/ProductFragments";
import { SiteFooter, SiteHeader } from "@/components/site/SiteChrome";
import { ButtonLink } from "@/components/ui/primitives";

const FEATURES = [
  {
    title: "Scheduling that respects time zones",
    body: "Set weekly hours and block days off. Customers see open times in their own time zone, and a slot is held for them while they pay, so two people can never book the same seat.",
    points: ["Weekly availability and blocked dates", "10-minute holds during checkout", "Daylight saving handled"],
    fragment: <BookingFragment />,
  },
  {
    title: "Payments and Meet links, without the copy-paste",
    body: "Customers pay with Razorpay. When the payment is confirmed, a Google Calendar event with a Meet link is created on your own calendar and the customer is invited.",
    points: ["Verified Razorpay webhooks, no double charges", "Events on your Google Calendar", "Refunds from the dashboard"],
    fragment: <RemindersFragment />,
  },
  {
    title: "WhatsApp first, SMS and email as backup",
    body: "The link goes out on WhatsApp with an SMS fallback, plus an email with a calendar file. Reminders follow 24 hours and 15 minutes before the session.",
    points: ["Approved WhatsApp templates", "Times in the customer's time zone", "Customers can reschedule or cancel themselves"],
    fragment: <WhatsAppFragment />,
  },
  {
    title: "One dashboard for sessions and earnings",
    body: "See what is coming up, who paid, which messages were delivered, and what needs your attention. Group sessions share one Meet link for every attendee.",
    points: ["Group sessions with seat limits", "Earnings by service, CSV export", "Alerts when something needs you"],
    fragment: <DashboardFragment />,
  },
];

const FAQ = [
  {
    q: "When do I receive the money?",
    a: "Payments are collected by Razorpay. Settlement timing follows your Razorpay account's settlement schedule, typically a few working days after capture.",
  },
  {
    q: "Do I need a Google account?",
    a: "Yes. Meet links are created on your own Google Calendar, so you connect a Google account once from the dashboard. Free Gmail accounts end group calls after 60 minutes; Google Workspace does not.",
  },
  {
    q: "Do customers need to opt in to WhatsApp?",
    a: "Yes. Customers tick a box to receive their link and reminders on WhatsApp. They always get the link by email and on the confirmation page too, so nobody depends on WhatsApp alone.",
  },
  {
    q: "How do refunds work?",
    a: "You choose a cancellation policy per service: full refund, full refund with 24 hours' notice, or no refund. If you cancel a session yourself, the customer is refunded in full. Refunds are issued through Razorpay from your dashboard.",
  },
  {
    q: "How many people can join a group session?",
    a: "You set the number of seats per service. Seats are counted as people book, so a session never oversells, and everyone gets the same Meet link.",
  },
  {
    q: "What happens to my customers' data?",
    a: "Customer names, emails and phone numbers are used only to deliver and manage their sessions. You can erase a customer's details on request. See the Privacy Policy for details.",
  },
];

/**
 * The landing page body (header, sections, footer). Rendered by the old Next page (app/page.tsx, which adds the
 * Organization JSON-LD) and by the SPA page; `loggedIn` only switches the header buttons.
 */
export function LandingView({ loggedIn }: { loggedIn: boolean }) {
  return (
    <>
      <SiteHeader loggedIn={loggedIn} />
      <main id="main">
        <section className="hero">
          <div className="container hero__grid">
            <div>
              <p className="eyebrow">For coaches, mentors and creators</p>
              <h1 className="hero__title" style={{ marginTop: 12 }}>
                Get paid for your time. The Meet link sends itself.
              </h1>
              <p className="hero__lede">
                Share one booking page. Customers pick a time and pay, and the Google Meet link reaches them on
                WhatsApp and email, with reminders before the session.
              </p>
              <div className="hero__actions">
                <ButtonLink href="/register" variant="primary" size="lg">
                  Create your booking page
                </ButtonLink>
                <ButtonLink href="/demo" size="lg">
                  See a demo booking page
                </ButtonLink>
              </div>
              <p className="hero__note">Your customers do not need an account to book.</p>
            </div>
            <BookingFragment />
          </div>
        </section>

        <section className="section section--muted" id="how-it-works" aria-labelledby="how-title">
          <div className="container">
            <div className="section__head">
              <p className="eyebrow">How it works</p>
              <h2 className="section__title" id="how-title">
                Four steps, and you only do the first one
              </h2>
            </div>
            <ol className="steps">
              <li>
                <h3>The customer picks a slot</h3>
                <p>From your weekly hours, shown in their own time zone. The slot is held while they pay.</p>
              </li>
              <li>
                <h3>They pay with Razorpay</h3>
                <p>Cards, UPI and netbanking. The booking is confirmed only when Razorpay confirms the payment.</p>
              </li>
              <li>
                <h3>The Meet link is created</h3>
                <p>A Google Calendar event with a Meet link appears on your calendar, and the customer is invited.</p>
              </li>
              <li>
                <h3>WhatsApp and email go out</h3>
                <p>The link arrives on WhatsApp (SMS if that fails) and by email, with reminders 24 hours and 15 minutes before.</p>
              </li>
            </ol>
          </div>
        </section>

        <section className="section" id="features" aria-labelledby="features-title">
          <div className="container">
            <div className="section__head">
              <p className="eyebrow">What you get</p>
              <h2 className="section__title" id="features-title">
                Everything between “I'd like to book” and “see you on the call”
              </h2>
            </div>
            {FEATURES.map((f, i) => (
              <div key={f.title} className={`feature${i % 2 ? " feature--flip" : ""}`}>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                  <ul>
                    {f.points.map((p) => (
                      <li key={p}>
                        <IconCheck size={16} />
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>{f.fragment}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="container" aria-labelledby="customers-title">
          <div className="strip">
            <div>
              <h2 id="customers-title">For your customers: no account needed.</h2>
              <p>They pay, get the link on WhatsApp and email, and can reschedule or cancel from a link in their email.</p>
            </div>
            <ButtonLink href="/demo" variant="secondary">
              Try the customer flow
            </ButtonLink>
          </div>
        </section>

        <section className="section" id="faq" aria-labelledby="faq-title">
          <div className="container container--narrow">
            <div className="section__head">
              <p className="eyebrow">FAQ</p>
              <h2 className="section__title" id="faq-title">
                Questions creators ask first
              </h2>
            </div>
            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="container">
          <div className="card cta">
            <h2>Ready to share your booking page?</h2>
            <p>Add a service, set your hours, connect Google Calendar, and share your link.</p>
            <div className="hero__actions" style={{ justifyContent: "center" }}>
              <ButtonLink href="/register" variant="primary" size="lg">
                Get started
              </ButtonLink>
              <ButtonLink href="/login" size="lg">
                Log in
              </ButtonLink>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
