import { AppLink } from "@web/lib/link";
import { PageHead } from "@web/components/app/AppShell";
import { Alert, Card, Stat } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminOverviewView } from "@/lib/views/admin-overview";
import { formatDateTime } from "@/lib/india";

type Money = Jsonify<AdminOverviewView>["overview"]["captured"];

function money(list: Money) {
  if (list.length === 0) return formatMoney(0, "INR");
  return list.map((m) => formatMoney(m.amountMinor, m.currency)).join(" · ");
}

/** The admin console's Overview page. Rendered by the SPA page from the endpoint's JSON. */
export function OverviewView({ data }: { data: Jsonify<AdminOverviewView> }) {
  const { overview: o, recentAudit, health } = data;
  const b = o.bookingsByStatus;
  const live = (b.SCHEDULED ?? 0) + (b.PAID ?? 0);
  const unhealthy = health.unhealthy;
  const alerts = [
    unhealthy.length > 0 && (
      <Alert
        key="health"
        tone={unhealthy.some((c) => c.status === "critical") ? "danger" : "warning"}
        title={`${unhealthy.length} system health ${unhealthy.length === 1 ? "issue" : "issues"}`}
      >
        {unhealthy.map((c) => c.label).join(", ")}. <AppLink href="/admin/health">Open System health</AppLink>.
      </Alert>
    ),
    o.attention.mismatched > 0 && (
      <Alert key="mm" tone="danger" title={`${o.attention.mismatched} captured payment(s) with no paid booking`}>
        Money was received but the booking never became paid. <AppLink href="/admin/payments?view=mismatch">Review them</AppLink>.
      </Alert>
    ),
    o.attention.needsRefund > 0 && (
      <Alert key="nr" tone="warning" title={`${o.attention.needsRefund} payment(s) flagged for refund`}>
        <AppLink href="/admin/payments?view=needs-refund">Review refunds</AppLink>.
      </Alert>
    ),
    o.attention.googleReconnect > 0 && (
      <Alert key="g" tone="warning" title={`${o.attention.googleReconnect} influencer(s) must reconnect Google`}>
        Their paid bookings wait without a Meet link until they reconnect. <AppLink href="/admin/influencers">See influencers</AppLink>.
      </Alert>
    ),
    o.attention.failedMessages7d > 0 && (
      <Alert key="fm" tone="warning" title={`${o.attention.failedMessages7d} message(s) failed in the last 7 days`} />
    ),
  ].filter(Boolean);

  return (
    <div className="stack stack--lg">
      <PageHead title="Overview" description="Everything across all influencers on the platform." />

      {alerts.length > 0 ? <div className="stack">{alerts}</div> : <Alert tone="success">Nothing needs attention right now.</Alert>}

      <div className="grid grid--3">
        <Card>
          <Stat label="Influencers" value={o.influencers.total} hint={`${o.influencers.onboarded} finished onboarding`} />
        </Card>
        <Card>
          <Stat label="Upcoming / paid sessions" value={live} hint={`${b.COMPLETED ?? 0} completed`} />
        </Card>
        <Card>
          <Stat label="Awaiting payment" value={(b.PENDING_PAYMENT ?? 0) + (b.HELD ?? 0)} hint={`${b.EXPIRED ?? 0} expired, ${b.CANCELLED ?? 0} cancelled`} />
        </Card>
        <Card>
          <Stat label="Gross collected" value={<span className="money">{money(o.captured)}</span>} hint="Captured payments, before refunds" />
        </Card>
        <Card>
          <Stat label="Refunded" value={<span className="money">{money(o.refunded)}</span>} />
        </Card>
        <Card>
          <Stat label="Failed bookings" value={b.FAILED ?? 0} hint="Need manual attention" />
        </Card>
      </div>

      <Card title="Recent admin activity" actions={<AppLink href="/admin/audit">View all</AppLink>}>
        {recentAudit.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ul className="stack stack--sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {recentAudit.map((a) => (
              <li key={a.id} className="row row--between text-sm">
                <span>
                  <strong>{a.adminEmail}</strong> · {a.action}
                  {a.targetType ? ` · ${a.targetType}` : ""}
                </span>
                <span className="subtle">{formatDateTime(new Date(a.createdAt), { weekday: false })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
