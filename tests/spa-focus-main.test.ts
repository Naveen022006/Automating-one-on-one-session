// M1: focus after an in-app navigation must never land on the `main` of a LOADING PLACEHOLDER (it is replaced when the data arrives, the
// focused element disappears and the focus falls to <body>). The decision is web/src/lib/focus-main.ts; FocusOnNavigate (a11y.tsx) calls
// it. The frame that carries the marker is rendered in tests/spa-booking-pages.test.ts. No DOM, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FOCUS_WAIT_MS, FOCUS_WAIT_PLACEHOLDER_MS, PLACEHOLDER_ATTR, focusWaitMs, isPlaceholder, realMain } from "../web/src/lib/focus-main";

/** The little of an element the decision looks at. */
function el(name: string, attrs: string[] = []) {
  return { name, attrs: new Set(attrs), focused: 0, hasAttribute(a: string) { return this.attrs.has(a); } };
}

test("a placeholder main is never the focus target; a real main is; nothing is nothing", () => {
  const placeholder = el("frame", [PLACEHOLDER_ATTR]);
  const real = el("page");
  assert.equal(isPlaceholder(placeholder), true);
  assert.equal(isPlaceholder(real), false);
  assert.equal(isPlaceholder(null), false);
  assert.equal(realMain(placeholder), null);
  assert.equal(realMain(real), real);
  assert.equal(realMain(null), null);
});

test("while a placeholder is on screen the watch lasts longer than for a page that has no main yet", () => {
  assert.equal(focusWaitMs(null), FOCUS_WAIT_MS);
  assert.equal(focusWaitMs(el("page")), FOCUS_WAIT_MS);
  assert.equal(focusWaitMs(el("frame", [PLACEHOLDER_ATTR])), FOCUS_WAIT_PLACEHOLDER_MS);
  assert.ok(FOCUS_WAIT_PLACEHOLDER_MS > FOCUS_WAIT_MS);
});

test("the whole sequence of /pay/<token> -> 'Choose another time' -> /demo/book: placeholder first, real page later, focus lands only on the real one", () => {
  // What FocusOnNavigate does on every DOM change: take #main, skip a placeholder, focus anything else.
  let current: ReturnType<typeof el> | null = null;
  const tryFocus = () => {
    const main = realMain(current);
    if (!main) return false;
    main.focused++;
    return true;
  };
  assert.equal(tryFocus(), false, "no main yet");
  const frame = el("frame", [PLACEHOLDER_ATTR]);
  current = frame;
  assert.equal(tryFocus(), false, "the loading frame is skipped (this is what used to take the focus and then lose it)");
  assert.equal(frame.focused, 0);
  const page = el("page");
  current = page; // the data arrived: QueryGate swapped the frame for the real view
  assert.equal(tryFocus(), true);
  assert.equal(page.focused, 1);
  assert.equal(frame.focused, 0, "the placeholder was never focused");
});
