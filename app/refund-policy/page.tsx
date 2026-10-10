import type { Metadata } from "next";
import { RefundPolicyView } from "@/components/views/public/RefundPolicyView";

export const metadata: Metadata = { title: "Refund and Cancellation Policy", alternates: { canonical: "/refund-policy" } };

export default function RefundPolicyPage() {
  return <RefundPolicyView />;
}
