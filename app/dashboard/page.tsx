import type { Metadata } from "next";
import Link from "next/link";
import { IconAlert, IconArrowRight } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { SessionsBoard } from "@/components/app/SessionsBoard";
import { CopyField } from "@/components/ui/overlays";
import { ButtonLink, Card, Stat } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { appUrl } from "@/lib/brand";
import { getOverview } from "@/lib/dashboard-data";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const auth = await requirePageAuth("/dashboard");
  const overview = await getOverview(auth.influencerId, auth.emailVerified);
  const publicUrl = `${appUrl()}/${auth.influencerSlug}`;
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date());
  const totals = overview.monthEarnings.totalsByCurrency;

  return (
    <div className="stack stack--lg">
      <PageHead title={`Hello, ${auth.influencerName.split(" ")[0]}`} description="Here is what is coming up and anything that needs you." />

      {overview.attention.length > 0 && (
        <Card title="Needs your attention">
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {overview.attention.map((a) => (
              <li key={a.kind} className="row row--between" style={{ alignItems: "flex-start" }}>
                <div className="row row--nowrap" style={{ alignItems: "flex-start" }}>
                  <span style={{ color: "var(--warning)", marginTop: 2 }}>
                    <IconAlert />
                  </span>
                  <div>
                    <p style={{ fontWeight: 600 }}>{a.title}</p>
                    <p className="muted text-sm">{a.detail}</p>
                  </div>
                </div>
                <ButtonLink href={a.href} size="sm">
                  Review <IconArrowRight size={16} />
                </ButtonLink>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid--3">
        <Card>
          <Stat label="Sessions in the next 7 days" value={overview.sessionsThisWeek} />
        </Card>
        <Card>
          <Stat
            label={`Earned in ${monthName}`}
            value={totals.length === 0 ? formatMoney(0, "INR") : totals.map((t) => formatMoney(t.amountMinor, t.currency)).join(" + ")}
            hint="Captured payments, net of refunds"
          />
        </Card>
        <Card>
          <div className="stack stack--sm">
            <span className="stat__label">Your booking page</span>
            <CopyField value={publicUrl} />
          </div>
        </Card>
      </div>

      <section className="stack" aria-labelledby="upcoming">
        <div className="row row--between">
          <h2 id="upcoming" className="section-title">
            Next 7 days
          </h2>
          <Link href="/dashboard/sessions" className="text-sm">
            All sessions
          </Link>
        </div>
        <SessionsBoard
          sessions={overview.upcoming}
          emptyTitle="Nothing booked this week"
          emptyBody="Share your booking page link to get your first booking."
        />
      </section>
    </div>
  );
}
