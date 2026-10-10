import Link from "next/link";
import { ResendVerification, VerifyEmail } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";

/**
 * `token` is the raw `?token=` value from the confirmation email. `user` is the signed-in influencer (null when nobody is
 * signed in); only these two fields are passed on, never the whole session.
 */
export function VerifyEmailView({ token, user }: { token?: string; user: { email: string; emailVerified: boolean } | null }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Confirm your email</h1>
        {token ? (
          <VerifyEmail token={token} loggedIn={user !== null} />
        ) : user && !user.emailVerified ? (
          <Alert tone="info" title={`We sent a link to ${user.email}`}>
            Open it to confirm your address. Can't find it? Check spam, or <ResendVerification />
          </Alert>
        ) : (
          <Alert tone="info">
            Open the link from your email. <Link href="/login">Log in</Link>
          </Alert>
        )}
      </div>
    </FocusedLayout>
  );
}
