import { AppLink } from "@web/lib/link";
import { PageHead } from "@web/components/app/AppShell";
import { Badge, Card, EmptyState, LinkTabs, Pagination } from "@web/components/ui/primitives";
import { IconUsers } from "@web/components/icons";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminInfluencersView } from "@/lib/views/admin-influencer";
import { InfluencerSearchForm } from "./InfluencerSearchForm";

/**
 * The admin console's Influencers list. `q` is the search text from the URL (the data already is the matching page). `busy` is
 * set by the SPA page while it still shows the previous search and the next one is loading. The tabs filter by account status
 * (`data.status`); Suspended and Awaiting approval carry a count.
 */
export function InfluencersView({ data, q, busy }: { data: Jsonify<AdminInfluencersView>; q?: string; busy?: boolean }) {
  const { status, counts } = data;
  // /admin/influencers?page=&status=&q= (only what is set; "all" is the absence of a status).
  const listHref = (s: string, page?: number) => {
    const parts = [page ? `page=${page}` : "", s !== "all" ? `status=${s}` : "", q ? `q=${encodeURIComponent(q)}` : ""].filter(Boolean);
    return `/admin/influencers${parts.length ? `?${parts.join("&")}` : ""}`;
  };
  const href = (p: number) => listHref(status, p);
  const tabs = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "not-live", label: "Not live" },
    { key: "suspended", label: "Suspended", count: counts.suspended },
    // Only meaningful while the approval gate is on, so it appears when somebody is waiting (or when it is the open tab).
    ...(counts.awaitingApproval > 0 || status === "awaiting-approval" ? [{ key: "awaiting-approval", label: "Awaiting approval", count: counts.awaitingApproval }] : []),
  ];
  // The search is a link-less soft navigation, which a screen reader does not announce: this line (a live region whose text changes) does.
  const found = `${data.total === 0 ? "No accounts" : `${data.total} ${data.total === 1 ? "account" : "accounts"}`}${q ? ` for “${q}”` : ""}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Influencers" description={`${data.total} account${data.total === 1 ? "" : "s"}`} />
      <LinkTabs items={tabs.map((t) => ({ label: t.label, href: listHref(t.key), current: status === t.key, count: t.count }))} />
      <Card>
        <InfluencerSearchForm q={q} status={status === "all" ? undefined : status} />
      </Card>
      {/* While the previous results stay on screen the new ones are loading: say that instead of the old total with the new search text. */}
      <p role="status" className="sr-only">{busy ? "Searching…" : found}</p>
      {data.rows.length === 0 ? (
        <EmptyState icon={<IconUsers />} title="No influencers found">
          {q ? "Try a different search." : status !== "all" ? "No accounts match this filter." : "Accounts appear here as people register."}
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
                    <AppLink href={`/admin/influencers/${r.id}`}>{r.name}</AppLink>
                    <div className="subtle">{r.email}</div>
                    {!r.live && r.blockers.length > 0 && <div className="subtle">Waiting for: {r.blockers.join(", ")}</div>}
                  </td>
                  <td data-label="Status">
                    {r.accountStatus === "suspended" ? (
                      <Badge tone="danger">Suspended</Badge>
                    ) : r.accountStatus === "awaiting-approval" ? (
                      <Badge tone="warning">Awaiting approval</Badge>
                    ) : r.live ? (
                      <Badge tone="success">Live</Badge>
                    ) : (
                      <Badge tone="warning">Not live</Badge>
                    )}{" "}
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
