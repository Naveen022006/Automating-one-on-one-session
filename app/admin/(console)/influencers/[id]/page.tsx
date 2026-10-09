import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead } from "@/components/app/AppShell";
import { Badge, Breadcrumb, Card, StatusPill } from "@/components/ui/primitives";
import { getInfluencerDetail } from "@/lib/admin/data";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Influencer" };

export default async function AdminInfluencerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getInfluencerDetail(id);
  if (!detail) notFound();
  const { influencer: i, bookings } = detail;

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
          </dl>
        </Card>
      </div>

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
