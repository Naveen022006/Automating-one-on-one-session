"use client";

import { ErrorView } from "@/components/views/system/ErrorView";

// The content lives in a shared view so the SPA's error screen renders exactly the same copy.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView error={error} reset={reset} />;
}
