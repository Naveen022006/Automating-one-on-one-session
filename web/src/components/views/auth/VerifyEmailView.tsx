import { AppLink } from "@web/lib/link";
import type { ReactNode } from "react";
import { ResendVerification, VerifyEmail } from "@web/components/auth/AuthForms";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { Alert } from "@web/components/ui/primitives";

/**
 * The focused frame with the page's heading. The SPA page also wraps its loading and error states in it, so the heading is
 * written once and every state of the page has it.
 */
export function VerifyEmailFrame({ children }: { children: ReactNode }) {
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <h1 className="focused__title">Confirm your email</h1>
        {children}
      </div>
    </FocusedLayout>
  );
}

/**
 * `token` is the raw `?token=` value from the confirmation email. `user` is the signed-in influencer (null when nobody is
 * signed in); only these two fields are passed on, never the whole session.
 */
export function VerifyEmailView({
  token,
  user,
  emailEnabled = true,
}: {
  token?: string;
  user: { email: string; emailVerified: boolean } | null;
  /** False when the platform sends no e-mail (doc/15): no link was sent, an administrator verifies the account. */
  emailEnabled?: boolean;
}) {
  return (
    <VerifyEmailFrame>
      {token ? (
        <VerifyEmail token={token} loggedIn={user !== null} />
      ) : user && !user.emailVerified && !emailEnabled ? (
        <Alert tone="info" title="Your administrator verifies new accounts">
          This site does not send e-mail, so there is no link to open. Your account ({user.email}) is confirmed by an administrator. You can keep setting up in the meantime; your booking page goes live once it is confirmed.
        </Alert>
      ) : user && !user.emailVerified ? (
        <Alert tone="info" title={`We sent a link to ${user.email}`}>
          Open it to confirm your address. Can't find it? Check spam, or <ResendVerification />
        </Alert>
      ) : (
        <Alert tone="info">
          Open the link from your email. <AppLink href="/login">Log in</AppLink>
        </Alert>
      )}
    </VerifyEmailFrame>
  );
}
