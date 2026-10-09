import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { PayoutForm } from "@/components/app/PayoutForm";
import { Card } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { getPayoutAccountView } from "@/lib/payout-account";

export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage() {
  const auth = await requirePageAuth("/dashboard/payouts");
  const account = await getPayoutAccountView(auth.influencerId);
  return (
    <div className="stack stack--lg">
      <PageHead title="Payouts" description="Where we send your earnings once payments have been reconciled." />
      <Card title="Payout details">
        <PayoutForm account={account} />
      </Card>
    </div>
  );
}
