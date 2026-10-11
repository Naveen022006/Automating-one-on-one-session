import { GetForm } from "@web/components/views/dashboard/GetForm";
import { Button, Input } from "@web/components/ui/primitives";

/**
 * The influencer search box. A plain GET form (it works without JavaScript, with the same field name as before), but with
 * JavaScript the submit is a client-side navigation: a React Router route change instead of a full page load. It is the same GetForm the Customers and Earnings filters use: the box is not rebuilt when the
 * URL changes (so focus stays in it while the next list loads, which `key` on the form used to break) and is set back to the
 * URL's value after back/forward. `status` is the open status tab; a search keeps it (a hidden field), and "all" sends none.
 */
export function InfluencerSearchForm({ q, status }: { q?: string; status?: string }) {
  return (
    <GetForm action="/admin/influencers" values={{ q: q ?? "", status: status ?? "" }} className="row" style={{ alignItems: "flex-end" }}>
      <Input name="q" placeholder="Search name, email or page address" defaultValue={q} aria-label="Search influencers" />
      {status && <input type="hidden" name="status" defaultValue={status} />}
      <Button type="submit">Search</Button>
    </GetForm>
  );
}
