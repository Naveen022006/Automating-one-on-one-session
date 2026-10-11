// QA-10 / M5: scroll restoration keys (web/src/lib/scroll.ts). React Router saves positions per `location.key`, and every freshly loaded
// document has the key "default", so a full page load inherited the scroll offset of the page before it. The keys are written to
// sessionStorage for the life of the tab, so they must not carry the token of a manage, pay, reset or verify link. No DB, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scrollRestorationKey } from "../web/src/lib/scroll";

const loc = (key: string, pathname: string, search = "", hash = "") => ({ key, pathname, search, hash });

test("fresh loads of different URLs do not share a saved scroll position", () => {
  const a = scrollRestorationKey(loc("default", "/terms"));
  const b = scrollRestorationKey(loc("default", "/privacy"));
  assert.notEqual(a, b, "the manage page must not open at the offset of the confirmation page");
  assert.notEqual(scrollRestorationKey(loc("default", "/")), scrollRestorationKey(loc("default", "/", "", "#faq")), "/#faq typed after / must not restore the old offset and skip the hash");
  assert.notEqual(scrollRestorationKey(loc("default", "/dashboard/sessions", "?view=past")), scrollRestorationKey(loc("default", "/dashboard/sessions", "?view=upcoming")));
  assert.notEqual(scrollRestorationKey(loc("default", "/demo/book", "?service=a")), scrollRestorationKey(loc("default", "/demo/book", "?service=b")));
});

test("a reload of the same page keeps its key, so it still comes back to where it was", () => {
  assert.equal(scrollRestorationKey(loc("default", "/demo/book", "?service=x")), scrollRestorationKey(loc("default", "/demo/book", "?service=x")));
  assert.equal(scrollRestorationKey(loc("default", "/", "", "#faq")), scrollRestorationKey(loc("default", "/", "", "#faq")));
});

test("entries made by in-app navigation keep their own unique key (back and forward are unchanged)", () => {
  assert.equal(scrollRestorationKey(loc("w9qluaue", "/terms")), "w9qluaue");
  assert.equal(scrollRestorationKey(loc("w9qluaue", "/manage/SECRET-TOKEN.abc", "?token=SECRET")), "w9qluaue", "random keys hold nothing of the URL");
  assert.notEqual(scrollRestorationKey(loc("a1b2c3", "/terms")), scrollRestorationKey(loc("d4e5f6", "/terms")));
});

test("M5: the stored key never contains the token of a manage or pay link, or of a reset-password or verify-email link", () => {
  const manage = "eyJiIjoiY212Mzh2MXN4MDAwMjBrdnc4bmZsd2duOCIsImV4cCI6MTc5NDI4MDE4NH0.LQBw8QQV6S1pdNNfPUCgAhCIWJnUmQ5cymojsPztxSQ";
  const pay = "eyJiIjoiY212M2E1cGpuMDAwMHlrdndnZmxlcTZqaSIsImV4cCI6MTc5MTc3Njc5NX0.xVQFTSXgiHydefsqDQ0GJ8nP-JPyhs-JDtdnlnk7Br4";
  const reset = "P_Ep7Pg55Y3YEhqECvPefArsYGCmRHTLXouNzgLVs6o";
  const cases: Array<[ReturnType<typeof loc>, string]> = [
    [loc("default", `/manage/${manage}`), manage],
    [loc("default", `/manage/${encodeURIComponent(manage)}`), encodeURIComponent(manage)],
    [loc("default", `/pay/${pay}`), pay],
    [loc("default", "/reset-password", `?token=${reset}`), reset],
    [loc("default", "/verify-email", `?token=${reset}`), reset],
    [loc("default", "/reset-password", `?a=1&token=${reset}&b=2`), reset],
  ];
  for (const [l, secret] of cases) {
    const key = scrollRestorationKey(l);
    assert.ok(!key.includes(secret) && !key.includes(secret.slice(0, 12)), `${l.pathname}${l.search} -> ${key}`);
    assert.ok(key.startsWith("initial:/"), key);
  }
  // Different tokens, same page: one key (harmless), and the non-secret parts of the URL stay in it.
  assert.equal(scrollRestorationKey(loc("default", `/manage/${manage}`)), scrollRestorationKey(loc("default", "/manage/another-token")));
  assert.equal(scrollRestorationKey(loc("default", "/manage/x")), "initial:/manage/:token");
  assert.equal(scrollRestorationKey(loc("default", "/reset-password", "?token=abc")), "initial:/reset-password");
  assert.equal(scrollRestorationKey(loc("default", "/reset-password", "?a=1&token=abc&b=2")), "initial:/reset-password?a=1&b=2");
  assert.equal(scrollRestorationKey(loc("default", "/demo/book", "?service=svc_1", "#top")), "initial:/demo/book?service=svc_1#top");
  // pages whose paths only LOOK like these are untouched: a profile with the slug "manage" is /manage, not /manage/<token>
  assert.equal(scrollRestorationKey(loc("default", "/manage")), "initial:/manage");
  assert.equal(scrollRestorationKey(loc("default", "/payments")), "initial:/payments");
});
