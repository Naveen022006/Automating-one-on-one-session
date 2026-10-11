import { PageHead } from "@/components/app/AppShell";
import { IconShield } from "@/components/icons";
import { EmptyState, Pagination } from "@/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { AdminAuditView } from "@/lib/views/admin-audit";

/**
 * The admin Audit log page body. Rendered by the old Next page and by the SPA page from the same JSON. `busy` is set by the SPA
 * page while it still shows the previous page and the next one is loading (the old page leaves it undefined).
 */
export function AuditView({ data, busy }: { data: Jsonify<AdminAuditView>; busy?: boolean }) {
  // Pagination is made of links that no longer reload the page, so nothing announces the new page: this line does (a live region whose text changes).
  const found = `${data.rows.length === 0 ? "No entries" : `${data.rows.length} ${data.rows.length === 1 ? "entry" : "entries"} shown`}, page ${data.page} of ${data.pageCount}.`;

  return (
    <div className="stack stack--lg">
      <PageHead title="Audit log" description="Every sensitive thing an administrator did. Entries cannot be edited." />
      <p role="status" className="sr-only">{busy ? "Loading…" : found}</p>
      <div className="stack stack--lg" aria-busy={busy || undefined}>
        {data.rows.length === 0 ? (
          <EmptyState icon={<IconShield />} title="No activity yet" />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Admin audit log</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Admin</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">IP</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((a) => (
                  <tr key={a.id}>
                    <td data-label="When">{new Date(a.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" })}</td>
                    <td data-label="Admin">{a.adminEmail}</td>
                    <td data-label="Action">{a.action}</td>
                    <td data-label="Target" className="subtle">{a.targetType ? `${a.targetType} ${a.targetId ?? ""}` : "—"}</td>
                    <td data-label="IP" className="subtle">{a.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} hrefFor={(p) => `/admin/audit?page=${p}`} />
      </div>
    </div>
  );
}
