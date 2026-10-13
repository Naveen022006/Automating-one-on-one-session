// QA-12: after vite:preloadError the reload goes to the page the user clicked, once a minute at most.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverFromPreloadError, type PreloadRecoveryDeps } from "../web/src/lib/preload-recovery";

function setup(over: Partial<PreloadRecoveryDeps> = {}) {
  const data = new Map<string, string>();
  const calls: string[] = [];
  const deps: PreloadRecoveryDeps = {
    storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) },
    now: () => 1_000_000,
    pendingTarget: () => null,
    reload: () => void calls.push("reload"),
    assign: (u) => void calls.push(`assign ${u}`),
    ...over,
  };
  return { deps, calls, data };
}

test("with a navigation in flight the user lands on the clicked page", () => {
  const { deps, calls } = setup({ pendingTarget: () => ({ pathname: "/dashboard/messages", search: "?a=1", hash: "#x" }) });
  assert.equal(recoverFromPreloadError(deps), true);
  assert.deepEqual(calls, ["assign /dashboard/messages?a=1#x"]);
});

test("without a pending navigation it reloads the current page", () => {
  const { deps, calls } = setup();
  assert.equal(recoverFromPreloadError(deps), true);
  assert.deepEqual(calls, ["reload"]);
});

test("a second failure within a minute is not handled (no reload loop)", () => {
  const { deps, calls } = setup();
  assert.equal(recoverFromPreloadError(deps), true);
  assert.equal(recoverFromPreloadError(deps), false);
  assert.equal(calls.length, 1);
});

test("blocked storage is not handled, and a protocol-relative target falls back to reload", () => {
  const broken = setup({ storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => {} } });
  assert.equal(recoverFromPreloadError(broken.deps), false);
  const odd = setup({ pendingTarget: () => ({ pathname: "//evil.example", search: "", hash: "" }) });
  recoverFromPreloadError(odd.deps);
  assert.deepEqual(odd.calls, ["reload"]);
});
