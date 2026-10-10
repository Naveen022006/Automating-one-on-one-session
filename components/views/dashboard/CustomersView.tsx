import { IconSearch, IconUsers } from "@/components/icons";
import { PageHead } from "@/components/app/AppShell";
import { EraseCustomer } from "@/components/app/CustomerActions";
import { Button, EmptyState, Input } from "@/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardCustomersView } from "@/lib/views/dashboard-customers";
import { GetForm } from "./GetForm";

function day(iso: string | null) {
  return iso ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso)) : "–";
}

/** The Customers page body. Rendered by the old Next page and by the SPA page from the same JSON. */
export function CustomersView({ data }: { data: Jsonify<DashboardCustomersView> }) {
  const { q, customers } = data;

  return (
    <div className="stack stack--lg">
      <PageHead title="Customers" description="Everyone who has booked with you. Customers do not have accounts; they are grouped by email." />
      <GetForm className="row" role="search" action="/dashboard/customers" values={{ q }}>
        <label htmlFor="q" className="sr-only">Search customers</label>
        <Input id="q" name="q" defaultValue={q} placeholder="Search by name or email" style={{ maxWidth: 360 }} />
        <Button type="submit">
          <IconSearch size={16} /> Search
        </Button>
      </GetForm>
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
