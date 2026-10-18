import { FindBookingsView } from "@web/components/views/booking/FindBookingsView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";

/** `/bookings`: "find your bookings" by e-mail (the lost-link recovery and the way in to the customer's data export and erasure). */
export function Component() {
  // The session answer also says whether the platform sends e-mail at all; until it arrives (or if it fails) the usual form shows.
  const session = useSession();
  return (
    <>
      <PageTitle title="Find your bookings" />
      <FindBookingsView emailEnabled={session.data?.emailEnabled !== false} />
    </>
  );
}
