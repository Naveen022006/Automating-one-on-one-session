import { IconMail } from "@/components/icons";
import { SiteFooter, SiteHeader } from "@/components/site/SiteChrome";
import { Card } from "@/components/ui/primitives";
import { SUPPORT_EMAIL } from "@/lib/brand";

export function ContactView() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="container container--narrow" style={{ paddingTop: 48 }}>
        <h1 className="display" style={{ fontSize: "var(--text-3xl)" }}>Contact us</h1>
        <p className="muted" style={{ marginTop: 12, maxWidth: "56ch" }}>
          For a question about a booking, include your booking reference from the confirmation email. To change or cancel
          a booking yourself, use the &ldquo;Reschedule or cancel&rdquo; link in that email.
        </p>
        <div className="grid grid--2" style={{ marginTop: 32 }}>
          <Card>
            <div className="stack stack--sm">
              <IconMail />
              <h2 className="card__title">Email</h2>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              <p className="subtle">We usually reply within one working day.</p>
            </div>
          </Card>
          <Card>
            <div className="stack stack--sm">
              <h2 className="card__title">Hosts</h2>
              <p className="muted text-sm">
                Logged-in hosts can see message delivery, payments and alerts for every session on the dashboard.
              </p>
              <a href="/dashboard">Open the dashboard</a>
            </div>
          </Card>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
