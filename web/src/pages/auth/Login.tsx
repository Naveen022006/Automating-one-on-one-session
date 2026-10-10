import { useSearchParams } from "react-router";
import { LoginView } from "@/components/views/auth/LoginView";
import { PageTitle } from "../../lib/head";

/**
 * Under the GuestOnly layout route: a signed-in visitor never sees this form (the guard sends them on to a validated `next`).
 * `next` and `reset` go to the view as the raw query values, like the old page's `searchParams`.
 */
export function Component() {
  const [params] = useSearchParams();
  return (
    <>
      <PageTitle title="Log in" />
      <LoginView next={params.get("next") ?? undefined} reset={params.get("reset") ?? undefined} />
    </>
  );
}
