// QA-2: keyboard focus after a failed submit and after a step change. Effects do not run in a static render and there is no DOM in
// these tests, so this checks the SOURCE of the two components for the wiring (the behaviour itself was verified in the browser):
// every focus target must exist (id + tabIndex -1) and every failed submit must call the focus helper.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const flow = readFileSync("app/[influencer]/book/BookingFlow.tsx", "utf8");
const auth = readFileSync("components/auth/AuthForms.tsx", "utf8");

test("booking flow: every step heading that the focus effect can name is a focusable element with that id", () => {
  const listed = /\["pick-service", "pick-time", "your-details", "pay-title", requested \? "requested-title" : "done-title"\]/.test(flow);
  assert.ok(listed, "the effect names the six headings by id");
  for (const id of ["pick-service", "pick-time", "your-details", "pay-title", "requested-title", "done-title"]) {
    assert.match(flow, new RegExp(`<h2 id="${id}" tabIndex=\\{-1\\}`), `${id} must be focusable (tabIndex -1), or focus() on it does nothing`);
  }
  assert.match(flow, /document\.getElementById\(stepHeadingId\)\?\.focus\(\)/);
  assert.match(flow, /if \(!stepMounted\.current\)/, "no focus move on the first render (the page's own focus handling owns that)");
});

test("booking flow: a failed submit focuses the first invalid field, and the opt-in error is announced and tied to its checkbox", () => {
  // The focus happens in an effect that depends on a counter bumped in the same batch as the errors (after a commit, never before).
  assert.match(flow, /setFocusErrors\(\(n\) => n \+ 1\)/);
  assert.match(flow, /detailsForm\.current\?\.querySelector<HTMLElement>\('\[aria-invalid="true"\]'\)\?\.focus\(\)/);
  assert.match(flow, /<form ref=\{detailsForm\}/);
  assert.equal(flow.split("setFocusErrors((n) => n + 1)").length - 1, 2, "after local validation and after the server's answer errors");
  assert.match(flow, /aria-describedby=\{errors\.optIn \? "optin-error" : undefined\}/);
  assert.match(flow, /id="optin-error" role="alert"/);
});

test("register form: local and server-side errors both move focus to the first invalid field; the live slug answer marks the input invalid", () => {
  assert.equal(auth.split("focusFirstInvalid()").length - 1, 2, "called after local validation and after a server answer");
  assert.match(auth, /const \{ formRef, focusFirstInvalid \} = useFocusFirstInvalid\(\)/);
  assert.match(auth, /<form ref=\{formRef\} className="stack" onSubmit=\{submit\} noValidate>\s*\{formError/);
  assert.match(auth, /setTick\(\(n\) => n \+ 1\)/, "an effect on a counter, so the focus follows the commit of the error texts");
  assert.match(auth, /describedBy\("reg-slug", \{ error: slugError, help: true \}\)/);
  assert.match(auth, /id="reg-terms-error" role="alert"/);
});
