/// <reference types="vite/client" />

/**
 * Compile-time constants injected by web/vite.config.ts (`define`). They are replaced textually at build time, so they
 * are NOT available in tests or in Node.
 */
declare const __DESIGN_PAGE__: boolean;
/** Dev server only: the origin of `next dev` that the Vite proxy forwards to. An empty string in a production build. */
declare const __NEXT_DEV_ORIGIN__: string;
