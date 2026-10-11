import { FindBookingsView } from "@web/components/views/booking/FindBookingsView";
import { PageTitle } from "../../lib/head";

/** `/bookings`: "find your bookings" by e-mail (the lost-link recovery and the way in to the customer's data export and erasure). */
export function Component() {
  return (
    <>
      <PageTitle title="Find your bookings" />
      <FindBookingsView />
    </>
  );
}
