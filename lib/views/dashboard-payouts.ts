import type { PayoutAccountData } from "@/components/app/PayoutForm";
import { getPayoutAccountView, type PayoutAccountView } from "@/lib/payout-account";
import { formatFeePercent, influencerPayoutSummary } from "@/lib/payouts";

/**
 * The Payouts page and the onboarding wizard's payout step. Shared by the old Next page, GET /api/dashboard/payouts and
 * loadOnboardingView.
 *
 * The account is the MASKED view only (`accountNumber` / `upiId` are "XXXXXX1234" / "ab***@okaxis"; the encrypted full
 * values are never selected into a view), and exactly the fields `PayoutForm` takes: no `updatedAt`, which nothing renders.
 */
export interface DashboardPayoutsView {
  account: PayoutAccountData | null;
  summary: {
    currencies: { currency: string; paidOutMinor: number; pendingMinor: number; readyMinor: number; waitingMinor: number }[];
    history: {
      id: string;
      status: string;
      currency: string;
      netMinor: number;
      feeMinor: number;
      paymentCount: number;
      /** What it was sent to, already masked when the payout was created. */
      destination: string;
      reference: string | null;
      paidAt: Date | null;
      createdAt: Date;
    }[];
  };
  /** The platform fee as the page prints it, for example "10%". */
  feePercentText: string;
}

/** The fields the payout form shows, picked one by one (never a spread of the stored view). */
export function toPayoutAccountData(account: PayoutAccountView | null): PayoutAccountData | null {
  if (!account) return null;
  return {
    method: account.method,
    accountHolderName: account.accountHolderName,
    bankName: account.bankName,
    ifsc: account.ifsc,
    accountNumber: account.accountNumber,
    upiId: account.upiId,
    status: account.status,
    rejectionReason: account.rejectionReason,
  };
}

export async function loadPayoutAccountData(influencerId: string): Promise<PayoutAccountData | null> {
  return toPayoutAccountData(await getPayoutAccountView(influencerId));
}

export async function loadPayoutsView(influencerId: string): Promise<DashboardPayoutsView> {
  const [account, summary] = await Promise.all([loadPayoutAccountData(influencerId), influencerPayoutSummary(influencerId)]);
  return {
    account,
    summary: {
      currencies: summary.currencies.map((c) => ({
        currency: c.currency,
        paidOutMinor: c.paidOutMinor,
        pendingMinor: c.pendingMinor,
        readyMinor: c.readyMinor,
        waitingMinor: c.waitingMinor,
      })),
      history: summary.history.map((h) => ({
        id: h.id,
        status: h.status,
        currency: h.currency,
        netMinor: h.netMinor,
        feeMinor: h.feeMinor,
        paymentCount: h.paymentCount,
        destination: h.destination,
        reference: h.reference,
        paidAt: h.paidAt,
        createdAt: h.createdAt,
      })),
    },
    feePercentText: formatFeePercent(summary.feeBps),
  };
}
