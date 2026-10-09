"use client";

import { useEffect } from "react";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { Button, ButtonLink } from "@/components/ui/primitives";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[ui:error]", error.digest ?? "", error.message);
  }, [error]);
  return (
    <FocusedLayout>
      <div className="stack stack--lg" role="alert">
        <p className="eyebrow">Something went wrong</p>
        <h1 className="focused__title">We could not load this page</h1>
        <p className="muted">
          This is on our side. Your bookings and payments are safe. Try again, and if it keeps happening contact us
          {error.digest ? ` with the reference ${error.digest}` : ""}.
        </p>
        <div className="row">
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <ButtonLink href="/">Home</ButtonLink>
        </div>
      </div>
    </FocusedLayout>
  );
}
