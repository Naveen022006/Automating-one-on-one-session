import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { Badge, Button, Card, EmptyState, Input, Pagination } from "@/components/ui/primitives";
import { IconUsers } from "@/components/icons";
import { listInfluencers, parsePage } from "@/lib/admin/data";
import { requireAdminPage } from "@/lib/admin/session";
import { formatMoney } from "@/lib/format";
import { WHATSAPP_BADGE } from "@/lib/readiness";

export const metadata: Metadata = { title: "Influencers" };

export default async function AdminInfluencersPage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  await requireAdminPage("/admin/influencers");
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = sp.q?.slice(0, 80);
  const data = await listInfluencers(page, q);
  const href = (p: number) => `/admin/influencers?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Influencers" description={`${data.total} account${data.total === 1 ? "" : "s"}`} />
      <Card>
        <form className="row" style={{ alignItems: "flex-end" }} action="/admin/influencers">
          <Input name="q" placeholder="Search name, email or page address" defaultValue={q} aria-label="Search influencers" />
          <Button type="submit">Search</Button>
        </form>
      </Card>
      {data.rows.length === 0 ? (
        <EmptyState icon={<IconUsers />} title="No influencers found">
          {q ? "Try a different search." : "Accounts appear here as people register."}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Influencers</caption>
            <thead>
              <tr>
                <th scope="col">Influencer</th>
                <th scope="col">Status</th>
                <th scope="col">Google</th>
                <th scope="col">WhatsApp</th>
                <th scope="col">Payout details</th>
                <th scope="col" className="num">Services</th>
                <th scope="col" className="num">Bookings</th>
                <th scope="col" className="num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Influencer">
                    <Link href={`/admin/influencers/${r.id}`}>{r.name}</Link>
                    <div className="subtle">{r.email}</div>
                    {!r.live && r.blockers.length > 0 && <div className="subtle">Waiting for: {r.blockers.join(", ")}</div>}
                  </td>
                  <td data-label="Status">
                    {r.live ? <Badge tone="success">Live</Badge> : <Badge tone="warning">Not live</Badge>}{" "}
                    {!r.emailVerified && <Badge tone="warning">Email unverified</Badge>}
                  </td>
                  <td data-label="Google">
                    {r.google === "connected" ? <Badge tone="success">Connected</Badge> : r.google === "reconnect" ? <Badge tone="danger">Reconnect</Badge> : <Badge>Not connected</Badge>}
                  </td>
                  <td data-label="WhatsApp">
                    <Badge tone={WHATSAPP_BADGE[r.whatsapp].tone}>{WHATSAPP_BADGE[r.whatsapp].label}</Badge>
                  </td>
                  <td data-label="Payout details">
                    {r.payout === "verified" ? <Badge tone="success">Verified</Badge> : r.payout === "pending" ? <Badge tone="warning">To review</Badge> : r.payout === "rejected" ? <Badge tone="danger">Needs correction</Badge> : <Badge>Not added</Badge>}
                  </td>
                  <td data-label="Services" className="num">{r.services}</td>
                  <td data-label="Bookings" className="num">{r.bookings}</td>
                  <td data-label="Gross" className="num">{formatMoney(r.grossMinor, "INR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={data.page} pageCount={data.pageCount} hrefFor={href} />
    </div>
  );
}
