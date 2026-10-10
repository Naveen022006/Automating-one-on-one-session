import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "./styles.css";
import { registerRouter } from "./lib/navigate";
import { queryClient } from "./lib/query";
import { TopLevelErrorBoundary } from "./pages/GlobalError";
import { router } from "./router";

/**
 * Entry point of the SPA (doc/10-react-migration-plan.md, F6). Mounts the React tree into the shell's `#root`.
 */

registerRouter(router);

// A tab that was open during a deploy asks for chunk files that no longer exist. Vite reports that as `vite:preloadError`;
// reload once to pick up the new build. The timestamp guard (sessionStorage, in try/catch because storage can be
// blocked) stops a reload loop if the files are really missing. /assets never falls back to HTML, so a missing chunk is a
// clean 404 here, not a MIME-type error.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const last = Number(window.sessionStorage.getItem("spa-reloaded-at") ?? 0);
    if (Date.now() - last > 60_000) {
      window.sessionStorage.setItem("spa-reloaded-at", String(Date.now()));
      event.preventDefault();
      window.location.reload();
    }
  } catch {
    // Storage unavailable: let the error reach the route's error screen instead of risking a loop.
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TopLevelErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TopLevelErrorBoundary>
  </StrictMode>,
);
