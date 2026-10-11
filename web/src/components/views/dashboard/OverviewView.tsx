import { AppLink } from "@web/lib/link";
import { IconAlert, IconArrowRight } from "@web/components/icons";
import { PageHead } from "@web/components/app/AppShell";
import { GoLiveChecklist } from "@web/components/app/GoLiveChecklist";
import { SessionsBoard } from "@web/components/app/SessionsBoard";
import { CopyField } from "@web/components/ui/overlays";
import { ButtonLink, Card, Stat } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardOverviewView } from "@/lib/views/dashboard-overview";

/** The dashboard Overview body. Rendered by the SPA page from the endpoint's JSON. */
export function OverviewView({ data }: { data: Jsonify<DashboardOverviewView> }) {
  const { overview, readiness, live, publicUrl } = data;
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date());
  const totals = overview.monthEarnings.totalsByCurrency;

  return (
    <div className="stack stack--lg">
      <PageHead title={`Hello, ${data.firstName}`} description="Here is what is coming up and anything that needs you." />

      <GoLiveChecklist readiness={readiness} live={live} />

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
          <AppLink href="/dashboard/sessions" className="text-sm">
            All sessions
          </AppLink>
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
