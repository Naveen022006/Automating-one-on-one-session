import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { Badge, Card, EmptyState, Pagination } from "@/components/ui/primitives";
import { IconUsers } from "@/components/icons";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminInfluencersView } from "@/lib/views/admin-influencer";
import { InfluencerSearchForm } from "./InfluencerSearchForm";

/**
 * The admin console's Influencers list. `q` is the search text from the URL (the data already is the matching page). `busy` is
 * set by the SPA page while it still shows the previous search and the next one is loading (the old page leaves it undefined).
 */
export function InfluencersView({ data, q, busy }: { data: Jsonify<AdminInfluencersView>; q?: string; busy?: boolean }) {
  const href = (p: number) => `/admin/influencers?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  // The search is a link-less soft navigation, which a screen reader does not announce: this line (a live region whose text changes) does.
  const found = `${data.total === 0 ? "No accounts" : `${data.total} ${data.total === 1 ? "account" : "accounts"}`}${q ? ` for “${q}”` : ""}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Influencers" description={`${data.total} account${data.total === 1 ? "" : "s"}`} />
      <Card>
        <InfluencerSearchForm q={q} />
      </Card>
      {/* While the previous results stay on screen the new ones are loading: say that instead of the old total with the new search text. */}
      <p role="status" className="sr-only">{busy ? "Searching…" : found}</p>
      {data.rows.length === 0 ? (
        <EmptyState icon={<IconUsers />} title="No influencers found">
          {q ? "Try a different search." : "Accounts appear here as people register."}
        </EmptyState>
      ) : (
        <div className="table-wrap" aria-busy={busy || undefined}>
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
                    <Badge tone={r.whatsapp.tone}>{r.whatsapp.text}</Badge>
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
