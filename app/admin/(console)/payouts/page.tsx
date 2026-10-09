import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { PayoutRowActions } from "@/components/admin/PayoutActions";
import { IconWallet } from "@/components/icons";
import { Badge, EmptyState, LinkTabs, Pagination } from "@/components/ui/primitives";
import { PAGE_SIZE, parsePage } from "@/lib/admin/data";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { formatFeePercent, postPayoutRefunds } from "@/lib/payouts";

export const metadata: Metadata = { title: "Payouts" };

const FILTERS = [
  { key: "PENDING", label: "To send" },
  { key: "PAID", label: "Paid" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "all", label: "All" },
] as const;

export default async function AdminPayoutsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const sp = await searchParams;
  const status = FILTERS.find((f) => f.key === sp.status)?.key ?? "PENDING";
  const page = parsePage(sp.page);
  const where = status === "all" ? {} : { status };
  const [total, rows, counts] = await Promise.all([
    prisma.payout.count({ where }),
    prisma.payout.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { influencer: { select: { id: true, name: true } } } }),
    prisma.payout.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const owed = new Map(await Promise.all(rows.filter((r) => r.status === "PAID").map(async (r) => [r.id, await postPayoutRefunds(r.id)] as const)));
  const countOf = (k: string) => (k === "all" ? counts.reduce((n, c) => n + c._count._all, 0) : (counts.find((c) => c.status === k)?._count._all ?? 0));

  return (
    <div className="stack stack--lg">
      <PageHead title="Payouts" description="Transfers to influencers. Create them from an influencer's page, send the money yourself, then record the bank reference here." />
      <LinkTabs items={FILTERS.map((f) => ({ label: f.label, href: `/admin/payouts?status=${f.key}`, current: status === f.key, count: countOf(f.key) }))} />
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
                  <td data-label="Created">{p.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}</td>
                  <td data-label="Influencer"><Link href={`/admin/influencers/${p.influencer.id}`}>{p.influencer.name}</Link></td>
                  <td data-label="Send to">{p.destination}</td>
                  <td data-label="Gross" className="num">{formatMoney(p.grossMinor - p.refundsMinor, p.currency)}</td>
                  <td data-label="Fee" className="num">{formatMoney(p.feeMinor, p.currency)} <span className="subtle">({formatFeePercent(p.feeBps)})</span></td>
                  <td data-label="To send" className="num"><strong>{formatMoney(p.netMinor, p.currency)}</strong></td>
                  <td data-label="Status">
                    {p.status === "PAID" ? <Badge tone="success">Paid</Badge> : p.status === "PENDING" ? <Badge tone="warning">To send</Badge> : <Badge>Cancelled</Badge>}
                    {p.reference && <div className="subtle">UTR {p.reference}</div>}
                    {(owed.get(p.id) ?? 0) > 0 && <div><Badge tone="danger">Refunded since: {formatMoney(owed.get(p.id)!, p.currency)} to recover</Badge></div>}
                  </td>
                  <td data-label="Actions"><PayoutRowActions payoutId={p.id} status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} hrefFor={(n) => `/admin/payouts?status=${status}&page=${n}`} />
    </div>
  );
}
