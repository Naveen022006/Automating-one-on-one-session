import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last-resort boundary (what app/global-error.tsx was): a crash OUTSIDE the router, where no stylesheet or component can be
 * trusted, so it renders with inline styles only. Same copy as the Next file.
 */
export function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ maxWidth: 440, margin: "15vh auto", padding: "0 20px", fontFamily: "system-ui, sans-serif", color: "#162033" }} role="alert">
      <h1 style={{ fontFamily: "Georgia, serif", fontWeight: 500 }}>Something went wrong</h1>
      <p style={{ color: "#5b5850" }}>
        Please try again. Your bookings and payments are safe.{error.digest ? ` Reference: ${error.digest}` : ""}
      </p>
      <button
        onClick={reset}
        style={{ minHeight: 44, padding: "0 20px", borderRadius: 8, border: 0, background: "#17694f", color: "#fff", fontWeight: 600, cursor: "pointer" }}
      >
        Try again
      </button>
    </main>
  );
}

/** Wraps the whole app in main.tsx. */
export class TopLevelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ui:error]", "", error.message, info.componentStack);
  }

  render() {
    if (this.state.error) return <GlobalError error={this.state.error} reset={() => window.location.reload()} />;
    return this.props.children;
  }
}
