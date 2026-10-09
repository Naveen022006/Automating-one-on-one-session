import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { IconShield } from "@/components/icons";
import { EmptyState, Pagination } from "@/components/ui/primitives";
import { listAudit, parsePage } from "@/lib/admin/data";

export const metadata: Metadata = { title: "Audit log" };

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const sp = await searchParams;
  const data = await listAudit(parsePage(sp.page));

  return (
    <div className="stack stack--lg">
      <PageHead title="Audit log" description="Every sensitive thing an administrator did. Entries cannot be edited." />
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
                  <td data-label="When">{a.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" })}</td>
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
  );
}
