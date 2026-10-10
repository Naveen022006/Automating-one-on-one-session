// proxy.ts with SPA_GROUPS empty or unset: production behaviour must be exactly what it was before the SPA existed.
// (Separate file from spa-proxy.test.ts because SPA_GROUPS is read when proxy.ts is first loaded.)
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";

let proxy: (req: NextRequest) => Promise<Response>;

before(async () => {
  process.env.RATE_LIMIT_STORE = "memory";
  delete process.env.SPA_GROUPS;
  proxy = (await import("../proxy")).proxy;
});

const req = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers });

test("with no SPA_GROUPS no page is rewritten: every URL stays with the old Next pages", async () => {
  for (const path of ["/", "/terms", "/privacy", "/login", "/register", "/demo", "/demo/book", "/pay/abc", "/manage/abc", "/a/b/c", "/design", "/admin/login", "/spa-shell-lookalike"]) {
    const res = await proxy(req(path, "GET", { cookie: `sa_session=${"B".repeat(43)}` }));
    assert.equal(res.headers.get("x-middleware-rewrite"), null, path);
    assert.equal(res.headers.get("x-middleware-next"), "1", path);
    assert.match(res.headers.get("content-security-policy") ?? "", /'nonce-[^']+' 'strict-dynamic'/, `${path}: the CSP and nonce are exactly as before`);
    assert.ok(res.headers.get("x-middleware-request-x-nonce"), path);
    assert.equal(res.headers.get("x-middleware-request-x-pathname"), path, `${path}: the admin layout still reads x-pathname`);
  }
});

test("the guards and redirects behave as they always did", async () => {
  const dashboard = await proxy(req("/dashboard"));
  assert.equal(dashboard.status, 307);
  assert.equal(new URL(dashboard.headers.get("location")!).pathname, "/login");
  const admin = await proxy(req("/admin"));
  assert.equal(admin.status, 307);
  assert.equal(new URL(admin.headers.get("location")!).pathname, "/admin/login");
  assert.equal((await proxy(req("/admin/login"))).status, 200, "the admin login page itself is not redirected");
});

test("the internal shell route stays unreachable even when the SPA is off", async () => {
  for (const path of ["/spa-shell", "/spa-shell/terms"]) assert.equal((await proxy(req(path, "GET", { "x-nonce": "forged" }))).status, 404, path);
});

test("empty and unknown values mean the same as unset (resolved when the module loads)", async () => {
  // parseSpaGroups is tested exhaustively in spa-routes.test.ts; this pins what the proxy does with the result.
  const { parseSpaGroups } = await import("../lib/spa/routes");
  for (const raw of [undefined, "", "   ", "nonsense", "pubic,auht"]) assert.equal(parseSpaGroups(raw).size, 0, String(raw));
});
