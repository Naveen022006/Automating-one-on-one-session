"use client";

// Last-resort boundary (the root layout itself failed), so it renders its own <html> with inline styles.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#fbfaf7", color: "#162033", margin: 0 }}>
        <main style={{ maxWidth: 440, margin: "15vh auto", padding: "0 20px" }} role="alert">
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
      </body>
    </html>
  );
}
