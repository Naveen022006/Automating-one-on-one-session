import { ActivityLog } from "@web/components/app/AccountActivityPanel";
import { Card } from "@web/components/ui/primitives";
import { queryKeys } from "@web/lib/query";

/**
 * The influencer's account activity (doc/13-product-build-plan.md, WP-C), the last card of the admin Influencer page: the same entries
 * the influencer sees in Settings (sign-ins, failed sign-ins, password and payout-detail changes, refunds, price changes, customer
 * erasures), 25 a page. Read-only; the endpoint is gated by `requireAdminMfa()`.
 */
export function InfluencerActivityPanel({ influencerId }: { influencerId: string }) {
  return (
    <Card title="Account activity">
      <div className="stack">
        <p className="subtle">What happened on this account, newest first. Entries are kept for one year and cannot be edited.</p>
        <ActivityLog
          keyFor={(page) => queryKeys.admin("influencer-activity", { id: influencerId, page })}
          urlFor={(page) => `/api/admin/influencers/${encodeURIComponent(influencerId)}/activity?page=${page}`}
          label="Account activity of this influencer"
        />
      </div>
    </Card>
  );
}
