import type { Metadata } from "next";
import { IconSearch, IconUsers } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { EraseCustomer } from "@/components/app/CustomerActions";
import { Button, EmptyState, Input } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { listCustomers } from "@/lib/dashboard-data";
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Customers" };

function day(iso: string | null) {
  return iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "–";
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const auth = await requirePageAuth("/dashboard/customers");
  const { q } = await searchParams;
  const customers = await listCustomers(auth.influencerId, q ?? null);

  return (
    <div className="stack stack--lg">
      <PageHead title="Customers" description="Everyone who has booked with you. Customers do not have accounts; they are grouped by email." />
      <form className="row" role="search" action="/dashboard/customers">
        <label htmlFor="q" className="sr-only">Search customers</label>
        <Input id="q" name="q" defaultValue={q ?? ""} placeholder="Search by name or email" style={{ maxWidth: 360 }} />
        <Button type="submit">
          <IconSearch size={16} /> Search
        </Button>
      </form>
      {customers.length === 0 ? (
        <EmptyState icon={<IconUsers />} title={q ? "No customers match" : "No customers yet"}>
          {q ? "Try a different name or email." : "People appear here after their first paid booking."}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table table--stack">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="num">Bookings</th>
                <th scope="col" className="num">Paid</th>
                <th scope="col">Last session</th>
                <th scope="col">Next session</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.email}>
                  <td data-label="Customer">
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    <a href={`mailto:${c.email}`} className="text-sm">{c.email}</a>
                  </td>
                  <td data-label="Bookings" className="num">{c.bookings}</td>
                  <td data-label="Paid" className="num">
                    {c.spentByCurrency.length ? c.spentByCurrency.map((s) => formatMoney(s.amountMinor, s.currency)).join(" + ") : "–"}
                  </td>
                  <td data-label="Last session">{day(c.lastSession)}</td>
                  <td data-label="Next session">{day(c.nextSession)}</td>
                  <td data-label="">
                    <EraseCustomer email={c.email} name={c.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="subtle">Erasing removes a customer&rsquo;s contact details from past bookings. Cancel upcoming bookings first.</p>
    </div>
  );
}
