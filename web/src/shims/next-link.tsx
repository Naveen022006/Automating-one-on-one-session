/**
 * `next/link` inside the SPA build (vite.config.ts aliases it here; web/tsconfig.json maps it for the type checker).
 * Shared components under components/ keep their `import Link from "next/link"` unchanged. Deleted in the cleanup branch,
 * when those imports are rewritten to @web/lib/link.
 */
export { AppLink as default } from "../lib/link";
