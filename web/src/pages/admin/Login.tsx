import { useSearchParams } from "react-router";
import { LoginView } from "@/components/views/admin/LoginView";
import { PageTitle } from "../../lib/head";

/**
 * `/admin/login`. The AdminGuestOnly layout route has already sent a fully signed-in administrator on; a password-only
 * session of an administrator who has 2FA ("verify") lands here and signs in again with a code. The sign-in itself is a
 * full page load (AdminLoginForm), so the new session starts with an empty query cache.
 */
export function Component() {
  const [params] = useSearchParams();
  return (
    <>
      <PageTitle title="Admin sign in" />
      <LoginView next={params.get("next") ?? undefined} />
    </>
  );
}
