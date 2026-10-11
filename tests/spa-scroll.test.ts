// QA-10: scroll restoration keys (web/src/lib/scroll.ts). React Router saves positions per `location.key`, and every freshly loaded
// document has the key "default", so a full page load inherited the scroll offset of the page before it. No database, no browser.
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
});

test("a reload of the same page keeps its key, so it still comes back to where it was", () => {
  assert.equal(scrollRestorationKey(loc("default", "/demo/book", "?service=x")), scrollRestorationKey(loc("default", "/demo/book", "?service=x")));
});

test("entries made by in-app navigation keep their own unique key (back and forward are unchanged)", () => {
  assert.equal(scrollRestorationKey(loc("w9qluaue", "/terms")), "w9qluaue");
  assert.notEqual(scrollRestorationKey(loc("a1b2c3", "/terms")), scrollRestorationKey(loc("d4e5f6", "/terms")));
  // and a unique key never collides with the "initial:" keys of fresh loads
  assert.ok(!scrollRestorationKey(loc("default", "/x")).startsWith("w"));
});
