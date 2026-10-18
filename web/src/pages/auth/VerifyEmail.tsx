import { useSearchParams } from "react-router";
import { VerifyEmailFrame, VerifyEmailView } from "@web/components/views/auth/VerifyEmailView";
import { PageTitle } from "../../lib/head";
import { useSession } from "../../lib/session";
import { PageError, PageLoading } from "../../lib/states";

/**
 * With a `?token=` (the emailed link) the page renders at once: confirming needs only the token, so a slow or failed session
 * check never blocks it. `user` (which only decides the button after confirming) follows the session when it arrives, and is
 * null while the check is pending or has failed. Without a token the content depends on who is signed in, so it waits for the
 * session, inside the same frame and with the same heading as the loaded page (a failed check shows the usual alert with
 * "Try again"). The shell answers this URL with `Referrer-Policy: no-referrer`.
 */
export function Component() {
  const [params] = useSearchParams();
  const token = params.get("token") || undefined;
  const session = useSession();
  const user = session.data?.authenticated ? { email: session.data.user.email, emailVerified: session.data.user.emailVerified } : null;

  return (
    <>
      <PageTitle title="Confirm your email" />
      {token || session.data !== undefined ? (
        <VerifyEmailView token={token} user={user} emailEnabled={session.data?.emailEnabled !== false} />
      ) : (
        <VerifyEmailFrame>
          {session.isPending ? <PageLoading /> : <PageError error={session.error ?? new Error("Unknown error")} onRetry={() => void session.refetch()} />}
        </VerifyEmailFrame>
      )}
    </>
  );
}
