import { useSearchParams } from "react-router";
import { ResetPasswordView } from "@/components/views/auth/ResetPasswordView";
import { PageTitle } from "../../lib/head";

/** The token comes from the emailed link's query string; the shell answers this URL with `Referrer-Policy: no-referrer`. */
export function Component() {
  const [params] = useSearchParams();
  return (
    <>
      <PageTitle title="Choose a new password" />
      <ResetPasswordView token={params.get("token") ?? undefined} />
    </>
  );
}
