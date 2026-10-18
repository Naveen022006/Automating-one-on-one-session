import { PageHead } from "@web/components/app/AppShell";
import { Alert, Badge, Breadcrumb, ButtonLink, Card, StatusPill } from "@web/components/ui/primitives";
import { AccountHelpActions } from "@web/components/admin/AccountHelpActions";
import { InfluencerActivityPanel } from "@web/components/admin/InfluencerActivityPanel";
import { InfluencerStatusPanel } from "@web/components/admin/InfluencerStatusPanel";
import { InfluencerWhatsAppWebPanel } from "@web/components/admin/InfluencerWhatsAppWebPanel";
import { PayoutPanel } from "@web/components/admin/PayoutPanel";
import { CreatePayoutButton, FeeForm, PayoutRowActions, PayoutStatusBadges } from "@web/components/admin/PayoutActions";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminInfluencerView } from "@/lib/views/admin-influencer";
import { formatDate, formatDateTime } from "@/lib/india";

/**
 * The admin console's Influencer page. Rendered by the SPA page from the endpoint's JSON. The payout
 * details it shows are the MASKED ones; the full number only appears after the audited "Reveal full details" action
 * (PayoutPanel), and the approval buttons of each payout are the VIEWING administrator's (computed on the server).
 */
export function InfluencerDetailView({ data }: { data: Jsonify<AdminInfluencerView> }) {
  const { influencer: i, connections, payoutAccount: payout, fee, verified, onlyOneAdmin, currencies, payouts, services, bookings } = data;

  return (
    <div className="stack stack--lg">
      <Breadcrumb items={[{ label: "Influencers", href: "/admin/influencers" }, { label: i.name }]} />
      <PageHead title={i.name} description={`${i.email} · /${i.slug}`} />
      <InfluencerStatusPanel influencerId={i.id} />

      <div className="grid grid--2">
        <Card title="Account">
          <dl className="kv">
            <dt>Onboarding</dt>
            <dd>{i.onboardedAt ? <Badge tone="success">Finished</Badge> : <Badge>In progress</Badge>}</dd>
            <dt>Email</dt>
            <dd>{i.emailVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}</dd>
            <dt>Joined</dt>
            <dd>{formatDate(new Date(i.createdAt), { weekday: false })}</dd>
          </dl>
          <AccountHelpActions influencerId={i.id} emailVerified={i.emailVerified} emailEnabled={data.emailEnabled} />
        </Card>
        <Card title="Go-live checklist">
          <ul className="stack stack--sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.readinessItems.map((c) => (
              <li key={c.key} className="row row--between">
                <span>{c.label}</span>
                {c.state === "done" ? <Badge tone="success">Done</Badge> : c.state === "attention" ? <Badge tone="danger">Needs action</Badge> : c.required ? <Badge tone="warning">Required</Badge> : <Badge>Recommended</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Connections">
          <dl className="kv">
            <dt>Google Calendar</dt>
            <dd>
              {connections.google.state === "none" ? (
                <Badge>Not connected</Badge>
              ) : connections.google.state === "active" ? (
                <Badge tone="success">{connections.google.email ?? "Connected"}</Badge>
              ) : (
                <Badge tone="danger">Reconnect needed</Badge>
              )}
            </dd>
            <dt>WhatsApp</dt>
            <dd>
              {/* The same state as the influencer's own checklist (lib/readiness.ts), with the number when there is one. */}
              <Badge tone={connections.whatsapp.tone}>{connections.whatsapp.text}</Badge>
            </dd>
            <dt>Google client</dt>
            <dd>{connections.googleClientSaved ? <Badge tone="success">Own client saved</Badge> : <Badge>None saved</Badge>}</dd>
            <dt>Email from Gmail</dt>
            <dd>{connections.gmailSend ? <Badge tone="success">On</Badge> : <Badge>{data.emailEnabled ? "Off (platform sender)" : "Off (no customer e-mail)"}</Badge>}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Payout details">
        <PayoutPanel influencerId={i.id} account={payout} />
      </Card>

      <Card title="Earnings and payouts" actions={<ButtonLink href={`/admin/money?influencerId=${encodeURIComponent(i.id)}`} size="sm">All money movements</ButtonLink>}>
        <div className="stack">
          <FeeForm influencerId={i.id} feeBps={fee.overrideBps} defaultBps={fee.defaultBps} />
          <p className="subtle">Current fee: {fee.feePercentText}. Changing it affects payouts created from now on, not ones already created.</p>
          {!verified && <Alert tone="warning">Payouts can be created once this influencer&apos;s payout details are verified.</Alert>}
          {onlyOneAdmin && (
            <Alert tone="warning" title="Payouts need a second administrator">
              Payout approval is on, but there is only one active administrator, and nobody can approve a payout they created. Create a second administrator
              with <code>npm run admin:create</code>, or set <code>PAYOUT_FOUR_EYES=false</code> if one person really handles payouts alone.
            </Alert>
          )}
          {currencies.length === 0 ? (
            <p className="muted">No paid sessions waiting to be paid out.</p>
          ) : (
            currencies.map((c) => (
              <div key={c.currency} className="card" style={{ padding: 16 }}>
                <div className="row row--between">
                  <div>
                    <strong>{formatMoney(c.readyMinor, c.currency)}</strong> ready to pay out
                    <div className="subtle">
                      {c.readyCount} payment(s), {formatMoney(c.readyGrossMinor, c.currency)} after refunds, minus {formatMoney(c.readyFeeMinor, c.currency)} fee
                    </div>
                  </div>
                  {c.readyCount > 0 && verified && <CreatePayoutButton influencerId={i.id} currency={c.currency} label={`Create ${c.currency} payout`} />}
                </div>
                {c.waitingCount > 0 && (
                  <p className="subtle" style={{ marginTop: 8 }}>
                    {formatMoney(c.waitingMinor, c.currency)} not payable yet: {c.waitingText}.
                  </p>
                )}
              </div>
            ))
          )}
          {payouts.length > 0 && (
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="sr-only">Payouts</caption>
                <thead>
                  <tr>
                    <th scope="col">Created</th>
                    <th scope="col">Send to</th>
                    <th scope="col" className="num">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Created">{formatDate(new Date(p.createdAt), { weekday: false })}</td>
                      <td data-label="Send to">{p.destination}</td>
                      <td data-label="Amount" className="num">{formatMoney(p.netMinor, p.currency)}</td>
                      <td data-label="Status">
                        <PayoutStatusBadges status={p.status} approval={p.approval} />
                        {p.reference && <div className="subtle">UTR {p.reference}</div>}
                        {p.owedMinor > 0 && <div><Badge tone="danger">Refunded since: {formatMoney(p.owedMinor, p.currency)} to recover</Badge></div>}
                      </td>
                      <td data-label="Actions"><PayoutRowActions payoutId={p.id} status={p.status} approval={p.approval} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card title={`Services (${services.length})`}>
        {services.length === 0 ? (
          <p className="muted">No services yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Services</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">Duration</th>
                  <th scope="col" className="num">Price</th>
                  <th scope="col">Active</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Title">{s.title}</td>
                    <td data-label="Type">{s.type === "GROUP" ? `Group (${s.capacity})` : "1:1"}</td>
                    <td data-label="Duration" className="num">{s.durationMin} min</td>
                    <td data-label="Price" className="num">{formatMoney(s.priceMinor, s.currency)}</td>
                    <td data-label="Active">{s.active ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent bookings">
        {bookings.length === 0 ? (
          <p className="muted">No bookings yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Recent bookings</caption>
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td data-label="Session">
                      {b.serviceTitle}
                      <div className="subtle">{formatDateTime(new Date(b.startTime), { weekday: false })}</div>
                    </td>
                    <td data-label="Customer">{b.customerName}</td>
                    <td data-label="Status"><StatusPill kind="booking" status={b.status} /></td>
                    <td data-label="Paid" className="num">{b.paidMinor ? formatMoney(b.paidMinor, b.currency) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InfluencerWhatsAppWebPanel influencerId={i.id} />
      <InfluencerActivityPanel influencerId={i.id} />
    </div>
  );
}
