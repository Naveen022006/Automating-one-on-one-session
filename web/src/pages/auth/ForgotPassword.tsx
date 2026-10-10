import { ForgotPasswordView } from "@/components/views/auth/ForgotPasswordView";
import { PageTitle } from "../../lib/head";

export function Component() {
  return (
    <>
      <PageTitle title="Reset your password" />
      <ForgotPasswordView />
    </>
  );
}
