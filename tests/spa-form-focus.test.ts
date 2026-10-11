// QA-2 / QA-11 / M4 / M7: keyboard focus after a failed submit and after a step change of the booking flow.
// Effects do not run in a static render and there is no DOM in these tests, so the RULES are tested where they live, as pure functions
// (web/src/components/ui/focus.ts) that BookingFlow and the register form call, plus what a server render of BookingFlow shows (the focus
// targets exist). No database, no browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingFlow } from "../web/src/pages/booking/BookingFlow";
import { INVALID_SELECTOR, REQUESTED_HEADING_ID, STEP_HEADING_IDS, focusFirstInvalid, headingToFocus, stepHeadingId } from "../web/src/components/ui/focus";

type FakeField = { id: string; focused: number; focus(): void };
const field = (id: string): FakeField => ({ id, focused: 0, focus() { this.focused++; } });
/** A form that answers querySelector the way the DOM does for the invalid marker: the first match in document order, else null. */
const form = (invalid: FakeField[]) => ({
  selectors: [] as string[],
  querySelector(selector: string) {
    this.selectors.push(selector);
    return selector === INVALID_SELECTOR ? (invalid[0] ?? null) : null;
  },
});

test("a failed submit focuses the FIRST invalid field, once, and does nothing when no field is marked", () => {
  const [name, email] = [field("name"), field("email")];
  const f = form([name, email]);
  assert.equal(focusFirstInvalid(f), true);
  assert.equal(name.focused, 1);
  assert.equal(email.focused, 0, "only the first one");
  assert.deepEqual(f.selectors, ['[aria-invalid="true"]'], "it looks for the invalid marker the field components set");
  assert.equal(focusFirstInvalid(form([])), false);
  assert.equal(focusFirstInvalid(null), false, "no form mounted yet: no crash");
});

test("step changes: the new step's heading gets the focus, in every direction and for the request confirmation", () => {
  const cases: Array<[number, number, boolean, string | null]> = [
    [0, 1, false, "pick-time"],
    [1, 2, false, "your-details"],
    [2, 3, false, "pay-title"],
    [3, 4, false, "done-title"],
    [3, 4, true, REQUESTED_HEADING_ID],
    [2, 4, true, REQUESTED_HEADING_ID], // an approval service skips the payment step
    [2, 1, false, "pick-time"], // "Change time"
    [1, 0, false, "pick-service"], // "Change session"
    [3, 1, false, "pick-time"], // "Pick a time again" after a hold ended
    [1, 1, false, null], // nothing changed
    [4, 4, true, null],
  ];
  for (const [from, to, requested, expected] of cases) assert.equal(headingToFocus(from, to, requested), expected, `${from} -> ${to}${requested ? " (request)" : ""}`);
  assert.equal(stepHeadingId(7, false), null, "no heading for a step that does not exist");
});

test("M4: React StrictMode runs the effect twice on mount; the page load must not move focus, a real step change must, exactly once", () => {
  // The effect of BookingFlow, as it runs: compare with the step seen last, remember the new one, focus what the rule names.
  const lastSeen = { current: 1 }; // useRef(step) on a booking page opened with ?service=
  const focused: Array<string | null> = [];
  const effect = (step: number, requested = false) => {
    const id = headingToFocus(lastSeen.current, step, requested);
    lastSeen.current = step;
    focused.push(id);
  };
  effect(1);
  effect(1); // StrictMode's second pass
  assert.deepEqual(focused, [null, null], "no focus on the first load, not even in the second pass");
  effect(2);
  effect(2); // StrictMode again after a re-render
  assert.deepEqual(focused.slice(2), ["your-details", null]);
});

test("the focus targets exist: the heading of the step a visitor lands on is focusable (tabindex -1) in the markup", () => {
  const services = [
    { id: "svc_1", title: "Career call", description: null, durationMin: 30, priceMinor: 49900, currency: "INR", type: "ONE_TO_ONE" as const, capacity: 1, refundText: "Full refund.", intakeQuestions: [], prepNotes: null, requiresApproval: false },
    { id: "svc_2", title: "Workshop", description: null, durationMin: 60, priceMinor: 19900, currency: "INR", type: "GROUP" as const, capacity: 5, refundText: "Full refund.", intakeQuestions: [], prepNotes: null, requiresApproval: false },
  ];
  const host = { name: "Demo Creator", photoUrl: null, slug: "demo", timezone: "Asia/Kolkata" };
  const step1 = renderToStaticMarkup(createElement(BookingFlow, { host, services, initialServiceId: "svc_2", preview: false }));
  assert.match(step1, /<h2 id="pick-time" tabindex="-1"/);
  const step0 = renderToStaticMarkup(createElement(BookingFlow, { host, services, initialServiceId: null, preview: false }));
  assert.match(step0, /<h2 id="pick-service" tabindex="-1"/);
});

test("every heading id the rule can name is a focusable h2 of BookingFlow (steps 2 to 4 cannot be rendered without a browser)", () => {
  const source = readFileSync("web/src/pages/booking/BookingFlow.tsx", "utf8");
  for (const id of [...STEP_HEADING_IDS, REQUESTED_HEADING_ID]) {
    assert.match(source, new RegExp(`<h2 id="${id}" tabIndex=\\{-1\\}`), `${id} must be focusable (tabIndex -1), or focus() on it does nothing`);
  }
});
