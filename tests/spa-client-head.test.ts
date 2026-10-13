// QA-3: after an in-app navigation the browser rewrites description, canonical, robots and the share card from the route
// table. clientHeadFor must agree with what the server shell writes (lib/spa/head.ts) for every table-only route.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHead } from "../lib/spa/head";
import { SPA_ROUTES, clientHeadFor, matchSpaRoute } from "../lib/spa/routes";

const ORIGIN = "https://app.example.com";
const ctx = { appUrl: ORIGIN, brand: "Acme", supportEmail: "h@a.example", designEnabled: false, loadProfile: async () => null };

test("clientHeadFor equals the server head for every route the table alone describes", async () => {
  for (const route of SPA_ROUTES) {
    if (route.head !== "static" && route.head !== "landing") continue;
    const server = await resolveHead(matchSpaRoute(route.path)!, ctx);
    const client = clientHeadFor(route.path, ORIGIN, "Acme");
    assert.equal(client.robots, server.robots, route.id);
    assert.equal(client.canonical, server.canonical, route.id);
    assert.equal(client.description, server.description, route.id);
    assert.equal(client.share?.title, server.share?.title, route.id);
    assert.equal(client.share?.description, server.share?.description, route.id);
    assert.equal(client.share?.url, server.share?.url, route.id);
  }
});

test("moving from the landing page to a private page drops canonical, description and share, and adds noindex", () => {
  const landing = clientHeadFor("/", ORIGIN, "Acme");
  assert.equal(landing.canonical, `${ORIGIN}/`);
  assert.ok(landing.share);
  const login = clientHeadFor("/login", ORIGIN, "Acme");
  assert.deepEqual(login, { description: undefined, canonical: undefined, robots: "noindex", share: undefined });
});

test("profile, booking, unknown and design paths get the conservative head", () => {
  for (const p of ["/priya", "/priya/book", "/design"]) assert.deepEqual(clientHeadFor(p, ORIGIN, "Acme"), { robots: "noindex" }, p);
  assert.deepEqual(clientHeadFor("/nope/a/b", ORIGIN, "Acme"), { robots: "noindex" });
  assert.deepEqual(clientHeadFor("/admin/zzz", ORIGIN, "Acme"), { robots: "noindex,nofollow" });
});
