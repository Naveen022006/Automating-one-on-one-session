import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/app/AppShell";
import { Alert, Badge, Breadcrumb, Card, StatusPill } from "@/components/ui/primitives";
import { PayoutPanel } from "@/components/admin/PayoutPanel";
import { activeAdminCount, getInfluencerDetail } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";
import { CreatePayoutButton, FeeForm, PayoutRowActions, PayoutStatusBadges } from "@/components/admin/PayoutActions";
import { prisma } from "@/lib/db";
import { WHATSAPP_BADGE, evaluateReadiness, readinessInput } from "@/lib/readiness";
import { getPayoutAccountView } from "@/lib/payout-account";
import { BLOCKER_LABEL, defaultFeeBps, effectiveFeeBps, formatFeePercent, fourEyesEnabled, loadPayable, payoutApprovalView, postPayoutRefunds, recentUnapprovedFor, summariseCurrencies, type Blocker } from "@/lib/payouts";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Influencer" };

export default async function AdminInfluencerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdminPage(`/admin/influencers/${id}`);
  const detail = await getInfluencerDetail(id);
  if (!detail) notFound();
  const { influencer: i, bookings } = detail;
  const payout = await getPayoutAccountView(id);
  const feeBps = effectiveFeeBps(i.platformFeeBps);
  const [payable, payouts] = await Promise.all([
    loadPayable(id),
    prisma.payout.findMany({ where: { influencerId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const currencies = summariseCurrencies(payable, feeBps);
  const owed = new Map(await Promise.all(payouts.filter((p) => p.status === "PAID").map(async (p) => [p.id, await postPayoutRefunds(p.id)] as const)));
  const recentUnapproved = await recentUnapprovedFor(payouts);
  const verified = payout?.status === "VERIFIED";
  const onlyOneAdmin = fourEyesEnabled() && (await activeAdminCount()) < 2;
  const input = readinessInput({ ...i, payoutAccount: payout ? { status: payout.status } : null, _count: { rules: await prisma.availabilityRule.count({ where: { influencerId: id } }), services: i.services.filter((s) => s.active).length } }, i.user?.emailVerifiedAt != null || !i.user);
  const readiness = evaluateReadiness(input);
  const waState = input.whatsapp;

  return (
    <div className="stack stack--lg">
      <Breadcrumb items={[{ label: "Influencers", href: "/admin/influencers" }, { label: i.name }]} />
      <PageHead title={i.name} description={`${i.email} · /${i.slug} · ${i.timezone}`} />

      <div className="grid grid--2">
        <Card title="Account">
          <dl className="kv">
            <dt>Onboarding</dt>
            <dd>{i.onboardedAt ? <Badge tone="success">Finished</Badge> : <Badge>In progress</Badge>}</dd>
            <dt>Email</dt>
            <dd>{i.user?.emailVerifiedAt ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}</dd>
            <dt>Joined</dt>
            <dd>{i.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}</dd>
          </dl>
        </Card>
        <Card title="Go-live checklist">
          <ul className="stack stack--sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {readiness.items.map((c) => (
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
              {!i.googleToken ? (
                <Badge>Not connected</Badge>
              ) : i.googleToken.status === "ACTIVE" ? (
                <Badge tone="success">{i.googleToken.googleEmail ?? "Connected"}</Badge>
              ) : (
                <Badge tone="danger">Reconnect needed</Badge>
              )}
            </dd>
            <dt>WhatsApp</dt>
            <dd>
              {/* The same state as the influencer's own checklist (lib/readiness.ts), with the number when there is one. */}
              <Badge tone={WHATSAPP_BADGE[waState].tone}>
                {i.whatsappConnection?.displayPhone && waState !== "error" ? `${i.whatsappConnection.displayPhone}, ${WHATSAPP_BADGE[waState].label.toLowerCase()}` : WHATSAPP_BADGE[waState].label}
              </Badge>
            </dd>
            <dt>Email from Gmail</dt>
            <dd>
              {i.googleToken?.scope.split(/\s+/).includes("https://www.googleapis.com/auth/gmail.send") ? <Badge tone="success">On</Badge> : <Badge>Off (platform sender)</Badge>}
            </dd>
          </dl>
        </Card>
      </div>

      <Card title="Payout details">
        <PayoutPanel influencerId={i.id} account={payout} />
      </Card>

      <Card title="Earnings and payouts">
        <div className="stack">
          <FeeForm influencerId={i.id} feeBps={i.platformFeeBps} defaultBps={defaultFeeBps()} />
          <p className="subtle">Current fee: {formatFeePercent(feeBps)}. Changing it affects payouts created from now on, not ones already created.</p>
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
                    {formatMoney(c.waitingMinor, c.currency)} not payable yet:{" "}
                    {(Object.entries(c.waitingByReason) as [Blocker, number][]).map(([r, n]) => `${n} ${BLOCKER_LABEL[r].toLowerCase()}`).join("; ")}.
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
                  {payouts.map((p) => {
                    const approval = payoutApprovalView(p, admin.email, process.env, recentUnapproved.get(p.id) ?? 0);
                    return (
                      <tr key={p.id}>
                        <td data-label="Created">{p.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}</td>
                        <td data-label="Send to">{p.destination}</td>
                        <td data-label="Amount" className="num">{formatMoney(p.netMinor, p.currency)}</td>
                        <td data-label="Status">
                          <PayoutStatusBadges status={p.status} approval={approval} />
                          {p.reference && <div className="subtle">UTR {p.reference}</div>}
                          {(owed.get(p.id) ?? 0) > 0 && <div><Badge tone="danger">Refunded since: {formatMoney(owed.get(p.id)!, p.currency)} to recover</Badge></div>}
                        </td>
                        <td data-label="Actions"><PayoutRowActions payoutId={p.id} status={p.status} approval={approval} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card title={`Services (${i.services.length})`}>
        {i.services.length === 0 ? (
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
                {i.services.map((s) => (
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
                {bookings.map((b) => {
                  const paid = b.payments.filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED").reduce((n, p) => n + p.amountMinor, 0);
                  return (
                    <tr key={b.id}>
                      <td data-label="Session">
                        {b.session.service.title}
                        <div className="subtle">{b.session.startTime.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                      </td>
                      <td data-label="Customer">{b.customerName}</td>
                      <td data-label="Status"><StatusPill kind="booking" status={b.status} /></td>
                      <td data-label="Paid" className="num">{paid ? formatMoney(paid, b.session.service.currency) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
