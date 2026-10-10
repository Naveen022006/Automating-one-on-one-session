/**
 * What the TYPE CHECKER sees as `next/navigation` in web/tsconfig.json (the bundler uses ./next-navigation.ts directly).
 *
 * Why it is a superset: `import type { X } from "@/lib/..."` in browser code makes tsc read the server file X lives in, and
 * some of those server files (lib/admin/session.ts, lib/auth/guards.ts) call `redirect()` / `notFound()` from
 * `next/navigation`. The path mapping applies to every file in the program, so without these declarations those type-only
 * imports would fail to type-check against the shim.
 *
 * It does NOT make server APIs usable in the browser: ./next-navigation.ts has no `redirect`, so a RUNTIME import of one
 * fails the Vite build ("is not exported by ...") and is also rejected by the server-module guard. Only types are declared.
 */
export * from "./next-navigation";

export declare function redirect(url: string, type?: "replace" | "push"): never;
export declare function permanentRedirect(url: string, type?: "replace" | "push"): never;
export declare function notFound(): never;
export declare function forbidden(): never;
export declare function unauthorized(): never;
