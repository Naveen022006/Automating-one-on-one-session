import { AppLink } from "@web/lib/link";
import type { ReactNode } from "react";
import { ExportLink, exportUrl } from "@web/components/admin/ExportControls";
import { PageHead } from "@web/components/app/AppShell";
import { IconArrowsLeftRight } from "@web/components/icons";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, Field, Input, LinkTabs, Pagination, Select, Stat, type Tone } from "@web/components/ui/primitives";
import { formatDateTime, formatMoney } from "@/lib/india";
import type { Jsonify } from "@/lib/jsonify";
import type { MoneyType } from "@/lib/admin/money";
import type { AdminMoneyView } from "@/lib/views/admin-money";
import { GetForm } from "../dashboard/GetForm";

type MoneyData = Jsonify<AdminMoneyView>;
type Row = MoneyData["rows"][number];

const money = (minor: number, currency: string) => <span className="money">{formatMoney(minor, currency)}</span>;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const TYPES: { key: MoneyType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "in", label: "Money in" },
  { key: "out", label: "Money out" },
  { key: "refunds", label: "Refunds" },
  { key: "payouts", label: "Payouts" },
];

/** The ids the server accepts (lib/http.ts ID_PATTERN), for deciding whether a filter in the URL may be sent back. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** `/admin/money?...` for a filter (the URL is the state of the page). */
export function moneyHref(q: { from: string; to: string; type: MoneyType; influencerId: string | null; page?: number }): string {
  const params = new URLSearchParams({ from: q.from, to: q.to, type: q.type });
  if (q.influencerId) params.set("influencerId", q.influencerId);
  if (q.page && q.page > 1) params.set("page", String(q.page));
  return `/admin/money?${params}`;
}

/** What each part of the page means. Shown at the bottom of the page. */
export const MONEY_DEFINITIONS: { term: string; text: string }[] = [
  { term: "Customer payment (money in)", text: "A payment that was captured (including one since refunded), on the day checkout began, that is when the payment's order was created. The schema keeps no capture time, so a payment the recovery job captured later stays on the day it began. This is the date the Reports page uses." },
  { term: "Refund to customer (money out)", text: "A refund, on the day it was recorded (requested). Pending and processed refunds count as money out; a failed refund is listed so you can see it, but it is not money out and is in no total." },
  { term: "Payout to influencer (money out)", text: "A payout that was marked as sent, on the day it was marked. The amount is what was sent (after the platform fee); the fee kept is shown beside it. The bank reference is shown by its last four characters." },
  { term: "Created, not sent yet", text: "Payouts that were created (some already approved) and not marked as sent. They are not money out yet, so they are listed apart and are not in the totals; they appear in the ledger on the day they are marked as sent. This list does not depend on the dates." },
  { term: "Totals", text: "The same figures, worked out by the same code, as the Reports page for the same dates (and for the influencer, when one is chosen). The tabs narrow the list of movements, not the totals. \"Still held\" is right now, before the platform fee, and does not depend on the dates." },
  { term: "Times", text: "Every day starts at 00:00 Indian Standard Time (IST); the end date is included." },
];

function typeLabel(type: MoneyType): string {
  return TYPES.find((t) => t.key === type)?.label ?? "All";
}

/** The filter form: a plain GET form (see GetForm), so it works without JavaScript. */
function FilterForm({ from, to, type, influencerId, options, truncated }: { from: string; to: string; type: MoneyType; influencerId: string | null; options: { id: string; name: string }[] | null; truncated: boolean }) {
  return (
    <Card>
      <GetForm className="row" style={{ alignItems: "flex-end" }} action="/admin/money" values={{ from, to, type, influencerId: influencerId ?? "" }}>
        <Field id="from" label="From">
          <Input id="from" name="from" type="date" defaultValue={from} />
        </Field>
        <Field id="to" label="To (included)">
          <Input id="to" name="to" type="date" defaultValue={to} />
        </Field>
        {options ? (
          <Field id="influencerId" label="Influencer">
            <Select id="influencerId" name="influencerId" defaultValue={influencerId ?? ""}>
              <option value="">All influencers</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </Select>
          </Field>
        ) : (
          influencerId && ID_SHAPE.test(influencerId) && <input type="hidden" name="influencerId" defaultValue={influencerId} />
        )}
        <input type="hidden" name="type" defaultValue={type} />
        <Button type="submit">Show</Button>
      </GetForm>
      {truncated && <p className="subtle" style={{ marginTop: 8 }}>The list shows the first {options?.length ?? 0} influencers by name. Open an influencer&apos;s page and choose &quot;All money movements&quot; to see the rest.</p>}
    </Card>
  );
}

/**
 * The page when the ledger could not be read (a range the server refused, a rate limit, a server error): the form stays on screen so the
 * dates can be changed, with the server's sentence or a plain one, and a "Try again" for a failure that may pass.
 */
export function MoneyProblem({ from, to, type, influencerId, title, message, onRetry }: { from: string; to: string; type: MoneyType; influencerId: string | null; title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Money" description="Every payment in, refund out and influencer payout, in one list." />
      <FilterForm from={from} to={to} type={type} influencerId={influencerId} options={null} truncated={false} />
      <Alert tone="danger" title={title} action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}>{message}</Alert>
    </div>
  );
}

function StatusBadge({ row }: { row: Row }) {
  const tones: Record<string, [string, Tone]> = {
    "payment:paid": ["Paid", "success"],
    "payment:refunded": ["Refunded", "info"],
    "payment:flagged": ["Flagged for refund", "warning"],
    "refund:pending": ["Pending", "neutral"],
    "refund:processed": ["Processed", "success"],
    "refund:failed": ["Failed, not counted", "danger"],
    "payout:paid": ["Sent", "success"],
  };
  const [label, tone] = tones[`${row.kind}:${row.status}`] ?? [row.status, "neutral" as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}

const MOVEMENT: Record<Row["kind"], { label: string; direction: string; tone: Tone }> = {
  payment: { label: "Customer payment", direction: "In", tone: "success" },
  refund: { label: "Refund to customer", direction: "Out", tone: "warning" },
  payout: { label: "Payout to influencer", direction: "Out", tone: "info" },
};

function Movement({ row }: { row: Row }) {
  const m = MOVEMENT[row.kind];
  return (
    <>
      <Badge tone={m.tone}>{m.direction}</Badge> {m.label}
    </>
  );
}

function Who({ row }: { row: Row }) {
  return (
    <>
      <AppLink href={`/admin/influencers/${row.influencer.id}`}>{row.influencer.name}</AppLink>
      {row.kind === "payout" ? (
        <>
          {row.destination && <div className="subtle">To {row.destination}</div>}
          {row.feeMinor !== null && <div className="subtle">Fee kept {formatMoney(row.feeMinor, row.currency)}</div>}
          {row.approvedBy && <div className="subtle">Approved by {row.approvedBy}</div>}
          {row.paidBy && <div className="subtle">Marked sent by {row.paidBy}</div>}
        </>
      ) : (
        <>
          <div className="subtle">
            {row.serviceTitle}
            {row.customerName ? ` · ${row.customerName}` : ""}
          </div>
          {row.bookingId && (
            <div className="subtle">
              <AppLink href={`/admin/bookings?q=${encodeURIComponent(row.bookingId)}`}>Booking</AppLink>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Reference({ row }: { row: Row }) {
  if (row.kind === "payout") {
    return (
      <>
        {row.referenceTail ? <div>UTR {row.referenceTail}</div> : <div className="subtle">No reference</div>}
        {row.payoutId && (
          <div className="subtle">
            <AppLink href={`/admin/payouts?status=PAID#payout-${row.payoutId}`}>Open in Payouts</AppLink>
          </div>
        )}
      </>
    );
  }
  return row.referenceTail ? <>Razorpay {row.referenceTail}</> : <span className="subtle">—</span>;
}

/**
 * A table cell. On a phone `table--stack` makes every `td` a flex row (the label, then what the cell holds), and each child of the cell would
 * become its own flex item beside the others, which makes the row wider than the screen. One wrapper element is one item that may shrink and
 * wrap (long names, an e-mail address), so the stacked rows fit the width; on a desktop the wrapper changes nothing.
 */
function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <td data-label={label} className={className}>
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>
    </td>
  );
}

function LedgerTable({ rows }: { rows: Row[] }) {
  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <caption className="sr-only">Money movements, newest first. Times are Indian Standard Time.</caption>
        <thead>
          <tr>
            <th scope="col">When (IST)</th>
            <th scope="col">Movement</th>
            <th scope="col">Who and what</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Amount</th>
            <th scope="col">Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <Cell label="When (IST)">{formatDateTime(new Date(r.at), { weekday: false })}</Cell>
              <Cell label="Movement"><Movement row={r} /></Cell>
              <Cell label="Who and what"><Who row={r} /></Cell>
              <Cell label="Status"><StatusBadge row={r} /></Cell>
              <Cell label="Amount" className="num">
                <span className="sr-only">{r.direction === "in" ? "In " : "Out "}</span>
                {r.direction === "in" ? "+" : "−"}
                {formatMoney(r.amountMinor, r.currency)}
                {r.kind === "payout" && <div className="subtle">after the fee</div>}
              </Cell>
              <Cell label="Reference"><Reference row={r} /></Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduledTable({ scheduled }: { scheduled: MoneyData["scheduled"] }) {
  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <caption className="sr-only">Payouts created and not sent yet, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Created (IST)</th>
            <th scope="col">Influencer</th>
            <th scope="col">Send to</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">To send</th>
            <th scope="col"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {scheduled.rows.map((p) => (
            <tr key={p.id}>
              <Cell label="Created (IST)">{formatDateTime(new Date(p.createdAt), { weekday: false })}</Cell>
              <Cell label="Influencer"><AppLink href={`/admin/influencers/${p.influencer.id}`}>{p.influencer.name}</AppLink></Cell>
              <Cell label="Send to">{p.destination}</Cell>
              <Cell label="Status">
                {p.approved ? <Badge tone="success">Approved, not sent yet</Badge> : <Badge tone="warning">Not sent yet</Badge>}
                {p.approvedBy && <div className="subtle">Approved by {p.approvedBy}</div>}
              </Cell>
              <Cell label="To send" className="num">
                {formatMoney(p.netMinor, p.currency)}
                <div className="subtle">fee {formatMoney(p.feeMinor, p.currency)}</div>
              </Cell>
              <Cell label="Open"><AppLink href={`/admin/payouts?status=PENDING#payout-${p.id}`}>Open in Payouts</AppLink></Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The admin Money page body. Rendered by the SPA page from the endpoint's JSON. `busy` is set by the SPA page while it still shows the
 * previous filter and the next one is loading. Every figure is in the minor units of its own currency; currencies are never added.
 */
export function MoneyView({ data, busy }: { data: MoneyData; busy?: boolean }) {
  const { from, to, type, influencer, totals, summary, scheduled } = data;
  const influencerId = influencer?.id ?? null;
  const label = typeLabel(type);
  const empty = data.total === 0;
  // A soft navigation to another filter or page is not announced by the browser: this line (a live region whose text changes) does it.
  const found = data.influencerUnknown
    ? "No influencer has that id."
    : `${label}${influencer ? `, ${influencer.name}` : ""}, ${from} to ${to}: ${empty ? "no money movements" : plural(data.total, "movement", "movements")}, page ${data.page} of ${data.pageCount}.${
        totals.length ? ` ${totals.map((t) => `${t.currency} in ${formatMoney(t.moneyInMinor, t.currency)}, refunds ${formatMoney(t.refundsOutMinor, t.currency)}, payouts ${formatMoney(t.payoutsOutMinor, t.currency)}`).join("; ")}.` : ""
      }`;
  const tabHref = (t: MoneyType) => moneyHref({ from, to, type: t, influencerId });

  return (
    <div className="stack stack--lg">
      <PageHead
        title="Money"
        description="Every payment in, refund out and influencer payout, newest first. Each currency is shown on its own; they are never added together."
        actions={<ExportLink href={exportUrl("money", from, to, { type, influencerId: influencerId ?? "" })} filename={`money-${from}-to-${to}.csv`} label="Export CSV" />}
      />
      <FilterForm from={from} to={to} type={type} influencerId={influencerId} options={data.influencers.options} truncated={data.influencers.truncated} />
      {data.influencerUnknown && (
        <Alert tone="warning" title="No influencer has that id">
          Nothing is shown. Choose an influencer from the list, or &quot;All influencers&quot;.
        </Alert>
      )}
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        <section className="stack" aria-labelledby="money-totals-title">
          <h2 id="money-totals-title" className="section-title">Totals, {from} to {to}{influencer ? `, ${influencer.name}` : ""}</h2>
          <p className="subtle">
            The Reports page figures for these dates. The tabs below narrow the list, not these totals.{" "}
            <AppLink href={`/admin/reports?from=${from}&to=${to}`}>Open Reports</AppLink>
          </p>
          {totals.length === 0 ? (
            <p className="muted">No payments, refunds or payouts in this range, and nothing held{influencer ? " for this influencer" : ""}.</p>
          ) : (
            totals.map((t) => (
              <Card key={t.currency} title={<h3 className="card__title">{t.currency}</h3>}>
                <div className="grid grid--3">
                  <Stat label="Money in" value={money(t.moneyInMinor, t.currency)} hint={plural(t.paymentCount, "payment", "payments")} />
                  <Stat label="Refunds out" value={money(t.refundsOutMinor, t.currency)} hint={plural(t.refundCount, "refund", "refunds")} />
                  <Stat label="Payouts out" value={money(t.payoutsOutMinor, t.currency)} hint={`${plural(t.payoutCount, "payout", "payouts")}, after the fee`} />
                  <Stat label="Platform fees kept" value={money(t.feesKeptMinor, t.currency)} hint="On the payouts sent in the range" />
                  <Stat label="Still held" value={money(t.stillHeldMinor, t.currency)} hint="Right now, for influencers, before the fee" />
                </div>
              </Card>
            ))
          )}
        </section>

        {influencer && summary && (
          <Card
            title={<h2 className="card__title">{influencer.name}: payouts</h2>}
            actions={<ButtonLink href={`/admin/influencers/${influencer.id}`}>Open influencer to create a payout</ButtonLink>}
          >
            {summary.currencies.length === 0 ? (
              <p className="muted">This influencer has no paid-out, payable or held money yet.</p>
            ) : (
              summary.currencies.map((c) => (
                <div key={c.currency} className="stack">
                  <h3 className="card__title">{c.currency}</h3>
                  <div className="grid grid--3">
                    <Stat label="Paid out to date" value={money(c.paidOutMinor, c.currency)} />
                    <Stat label="Payable now" value={money(c.payableMinor, c.currency)} hint={`After the ${summary.feePercentText} platform fee, ready for the next payout`} />
                    <Stat label="Held, not payable yet" value={money(c.heldMinor, c.currency)} hint="Waiting for reconciliation or for the hold period" />
                    <Stat label="In pending payouts" value={money(c.pendingMinor, c.currency)} hint="Created, not sent yet" />
                  </div>
                </div>
              ))
            )}
            <p className="subtle" style={{ marginTop: 12 }}>
              {summary.lastPayout
                ? `Last payout: ${formatMoney(summary.lastPayout.netMinor, summary.lastPayout.currency)} on ${formatDateTime(new Date(summary.lastPayout.paidAt), { weekday: false })}.`
                : "No payout has been sent to this influencer yet."}
            </p>
          </Card>
        )}

        <section className="stack" aria-labelledby="money-ledger-title">
          <h2 id="money-ledger-title" className="section-title">Movements</h2>
          <LinkTabs items={TYPES.map((t) => ({ label: t.label, href: tabHref(t.key), current: type === t.key }))} />
          {empty ? (
            <EmptyState icon={<IconArrowsLeftRight />} title="No money moved">
              There are no {type === "all" ? "payments, refunds or payouts" : label.toLowerCase()} in this range{influencer ? " for this influencer" : ""}. Choose other dates or another tab.
            </EmptyState>
          ) : (
            <LedgerTable rows={data.rows} />
          )}
          <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => moneyHref({ from, to, type, influencerId, page: p })} />
        </section>

        {scheduled.shown && (
          <section className="stack" aria-labelledby="money-scheduled-title">
            <h2 id="money-scheduled-title" className="section-title">Payouts created, not sent yet</h2>
            <p className="subtle">
              Scheduled to go out: not money out until they are marked as sent. This list does not depend on the dates.
              {scheduled.sums.length > 0 && ` Waiting: ${scheduled.sums.map((s) => `${formatMoney(s.netMinor, s.currency)} (${plural(s.count, "payout", "payouts")})`).join("; ")}.`}
            </p>
            {scheduled.total === 0 ? (
              <p className="muted">No payout is waiting to be sent{influencer ? " for this influencer" : ""}.</p>
            ) : (
              <>
                <ScheduledTable scheduled={scheduled} />
                {scheduled.total > scheduled.rows.length && (
                  <p className="subtle">
                    Showing the newest {scheduled.rows.length} of {scheduled.total}. <AppLink href="/admin/payouts?status=PENDING">Open all in Payouts</AppLink>
                  </p>
                )}
              </>
            )}
          </section>
        )}

        <Card title={<h2 className="card__title">What the dates and amounts mean</h2>}>
          <dl className="kv">
            {MONEY_DEFINITIONS.map((d) => (
              <div key={d.term} style={{ display: "contents" }}>
                <dt>{d.term}</dt>
                <dd>{d.text}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
