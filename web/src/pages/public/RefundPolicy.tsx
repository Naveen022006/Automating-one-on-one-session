import { RefundPolicyView } from "@/components/views/public/RefundPolicyView";
import { PageTitle } from "../../lib/head";

export function Component() {
  return (
    <>
      <PageTitle title="Refund and Cancellation Policy" />
      <RefundPolicyView />
    </>
  );
}
