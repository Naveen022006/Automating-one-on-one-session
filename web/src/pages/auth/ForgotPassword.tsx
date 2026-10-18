import { ForgotPasswordView } from "@web/components/views/auth/ForgotPasswordView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";

export function Component() {
  // Whether the platform sends e-mail comes with the session answer. Until it arrives (or if it fails) the form shows, and the server's
  // own answer to a submitted request still tells the truth (AuthForms ForgotForm).
  const session = useSession();
  return (
    <>
      <PageTitle title="Reset your password" />
      <ForgotPasswordView emailEnabled={session.data?.emailEnabled !== false} />
    </>
  );
}
