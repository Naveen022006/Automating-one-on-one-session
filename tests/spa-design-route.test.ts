// QA-4: without the design page the router must answer /design with the 404 view itself, not through the `/:slug` profile
// route (which would call /api/public/profiles/design). The router needs Vite's defines, so this pins the source shape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("web/src/router.tsx maps /design to NotFound when __DESIGN_PAGE__ is off", () => {
  const src = readFileSync(new URL("../web/src/router.tsx", import.meta.url), "utf8");
  assert.match(src, /__DESIGN_PAGE__\s*\?\s*\[leaf\("design"\)\]\s*:\s*\[\{\s*path:\s*"\/design",\s*element:\s*<NotFound\s*\/>\s*\}\]/);
});
