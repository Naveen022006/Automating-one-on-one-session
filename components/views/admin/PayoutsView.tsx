import Link from "next/link";
import { PayoutRowActions, PayoutStatusBadges } from "@/components/admin/PayoutActions";
import { PageHead } from "@/components/app/AppShell";
import { IconWallet } from "@/components/icons";
import { Alert, Badge, EmptyState, LinkTabs, Pagination } from "@/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminPayoutsView, PayoutFilter } from "@/lib/views/admin-payouts";

const FILTERS: { key: PayoutFilter; label: string }[] = [
  { key: "PENDING", label: "To send" },
  { key: "PAID", label: "Paid" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "all", label: "All" },
];

/**
 * The admin Payouts page body. Rendered by the old Next page and by the SPA page from the same JSON; the approval buttons of
 * each row come from the server, worked out for the administrator who is looking (the creator of a payout cannot approve it).
 * `busy` is set by the SPA page while it still shows the previous tab or page and the next one is loading.
 */
export function PayoutsView({ data, busy }: { data: Jsonify<AdminPayoutsView>; busy?: boolean }) {
  const { status, rows, counts } = data;
  const label = FILTERS.find((f) => f.key === status)?.label ?? "To send";
  const total = counts[status];
  // Tabs and pagination are links that no longer reload the page, so nothing announces the new list: this line does (a live region whose text changes).
  const found = `${label}: ${total === 0 ? "no payouts" : `${total} ${total === 1 ? "payout" : "payouts"}`}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Payouts" description="Transfers to influencers. Create them from an influencer's page, have a second administrator approve them, send the money yourself, then record the bank reference here." />
      {data.onlyOneAdmin && (
        <Alert tone="warning" title="Payouts need a second administrator">
          Payout approval is on, but there is only one active administrator, and nobody can approve a payout they created. Create a second administrator
          with <code>npm run admin:create</code>, or set <code>PAYOUT_FOUR_EYES=false</code> if one person really handles payouts alone.
        </Alert>
      )}
      <LinkTabs items={FILTERS.map((f) => ({ label: f.label, href: `/admin/payouts?status=${f.key}`, current: status === f.key, count: counts[f.key] }))} />
      <p role="status" className="sr-only">{found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {rows.length === 0 ? (
          <EmptyState icon={<IconWallet />} title="No payouts here">
            Payouts appear when you create one from an influencer&apos;s page.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Payouts</caption>
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Influencer</th>
                  <th scope="col">Send to</th>
                  <th scope="col" className="num">Gross</th>
                  <th scope="col" className="num">Fee</th>
                  <th scope="col" className="num">To send</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Created">{new Date(p.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</td>
                    <td data-label="Influencer"><Link href={`/admin/influencers/${p.influencer.id}`}>{p.influencer.name}</Link></td>
                    <td data-label="Send to">{p.destination}</td>
                    <td data-label="Gross" className="num">{formatMoney(p.grossAfterRefundsMinor, p.currency)}</td>
                    <td data-label="Fee" className="num">{formatMoney(p.feeMinor, p.currency)} <span className="subtle">({p.feePercentText})</span></td>
                    <td data-label="To send" className="num"><strong>{formatMoney(p.netMinor, p.currency)}</strong></td>
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
        <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(n) => `/admin/payouts?status=${status}&page=${n}`} />
      </div>
    </div>
  );
}
