import { RegisterView } from "@/components/views/auth/RegisterView";
import { PageTitle } from "../../lib/head";

/** Under the GuestOnly layout route (a signed-in visitor goes on to the dashboard). */
export function Component() {
  return (
    <>
      <PageTitle title="Create your account" />
      <RegisterView />
    </>
  );
}
