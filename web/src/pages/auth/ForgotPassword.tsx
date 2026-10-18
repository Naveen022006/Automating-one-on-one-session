import { ForgotPasswordView } from "@web/components/views/auth/ForgotPasswordView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";

export function Component() {
  // Whether the platform sends e-mail comes with the session answer. While it is on its way nothing is promised; if the check fails the
  // form shows (the server's own answer to a submitted request still tells the truth, see ForgotForm in AuthForms).
  const session = useSession();
  return (
    <>
      <PageTitle title="Reset your password" />
      <ForgotPasswordView emailEnabled={session.data?.emailEnabled !== false} loading={session.data === undefined && session.isPending} />
    </>
  );
}
