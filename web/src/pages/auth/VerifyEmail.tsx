import { useSearchParams } from "react-router";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { VerifyEmailView } from "@/components/views/auth/VerifyEmailView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";
import { PageError, PageLoading } from "../../lib/states";

/**
 * Needs to know whether someone is signed in (the "we sent a link to ..." hint and the button after confirming), so it waits for
 * the session check, inside the same focused frame as the loaded page. The shell answers this URL with `Referrer-Policy: no-referrer`.
 */
export function Component() {
  const [params] = useSearchParams();
  const session = useSession();
  const title = <PageTitle title="Confirm your email" />;

  if (session.data === undefined) {
    return (
      <>
        {title}
        <FocusedLayout>
          {session.isPending ? <PageLoading /> : <PageError error={session.error ?? new Error("Unknown error")} onRetry={() => void session.refetch()} />}
        </FocusedLayout>
      </>
    );
  }
  const user = session.data.authenticated ? { email: session.data.user.email, emailVerified: session.data.user.emailVerified } : null;
  return (
    <>
      {title}
      <VerifyEmailView token={params.get("token") ?? undefined} user={user} />
    </>
  );
}
