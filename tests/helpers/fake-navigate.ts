// A stand-in for web/src/lib/navigate.tsx, for tests that render components on the server (react-dom/server).
//
// The real module needs a React Router and a TanStack Query provider (useRouter reads both); a server render in a test has
// neither. Register it BEFORE the components are imported:
//
//   mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/dashboard") });
//
// It exports every name of the real module, not only the hooks the components call: web/src/lib/link.tsx loads query.ts and
// api.ts, and api.ts imports `appNavigate` from the same file, so a partial stand-in would fail to link.
export const fakeRouter = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };

export function fakeNavigate(pathname = "/") {
  return {
    useRouter: () => fakeRouter,
    usePathname: () => pathname,
    useAppNavigate: () => () => {},
    appNavigate: () => {},
    registerRouter: () => {},
    AppNavigate: () => null,
  };
}
