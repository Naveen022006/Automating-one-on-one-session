// web/src/lib/groups.ts under the Vite dev server: there is no <meta name="spa-groups">, so every group counts as enabled
// (the dev server has no old Next pages to link to; unported pages show the placeholder). Separate file from
// spa-groups.test.ts because the module reads the meta tag once, when it is first imported.
import assert from "node:assert/strict";
import { before, test } from "node:test";

let isSpaHref: (href: string) => boolean;
let enabledGroups: ReadonlySet<string>;

before(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window = { location: new URL("http://localhost:5173/dashboard") };
  g.document = { querySelector: () => null };
  ({ isSpaHref, enabledGroups } = await import("../web/src/lib/groups"));
});

test("without the meta tag every group is enabled", () => {
  assert.deepEqual([...enabledGroups].sort(), ["admin", "auth", "booking", "dashboard", "public"]);
  for (const href of ["/", "/login", "/dashboard/sessions", "/admin/payments", "/demo", "/pay/x", "/anything/else/here"]) assert.equal(isSpaHref(href), true, href);
  for (const href of ["/api/auth/session", "/assets/x.js", "https://example.com/", "mailto:a@b.example"]) assert.equal(isSpaHref(href), false, href);
});
