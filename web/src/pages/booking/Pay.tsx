import { useParams } from "react-router";
import { PayView } from "@web/components/views/booking/PayView";
import type { PayView as PayViewData } from "@/lib/views/booking-pay";
import { useApiQuery } from "../../lib/api";
import { PageTitle } from "../../lib/head";
import type { Jsonify } from "../../lib/jsonify";
import { queryKeys } from "../../lib/query";
import { QueryGate } from "../../lib/states";

/**
 * `/pay/:token`. The route param is already percent-decoded by React Router (nothing to decode by hand); the
 * request encodes it again. Every state of the booking, an invalid link included, is a 200 answer with a `state`.
 */
export function Component() {
  const { token = "" } = useParams();
  const query = useApiQuery<Jsonify<PayViewData>>(queryKeys.pay(token), `/api/pay/${encodeURIComponent(token)}`);
  return (
    <>
      <PageTitle title="Complete your booking" />
      <QueryGate query={query} framed>
        {(data) => <PayView data={data} />}
      </QueryGate>
    </>
  );
}
