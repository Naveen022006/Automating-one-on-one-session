import { RegisterView } from "@web/components/views/auth/RegisterView";
import { PageTitle } from "../../lib/head";

/**
 * Under the GuestOnly layout route: a signed-in visitor never sees this form, the guard sends them on to `safeNextPath(next)`
 * (the dashboard unless there is a valid `?next=`).
 */
export function Component() {
  return (
    <>
      <PageTitle title="Create your account" />
      <RegisterView />
    </>
  );
}
