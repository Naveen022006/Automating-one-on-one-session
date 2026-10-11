// M3: a NUL character in public input must be a 400, never a Postgres error (a 500). The shared pieces are in lib/http.ts (`readJson`,
// `containsNul`, `isEntityId`) and proxy.ts (path and query string, tested in spa-proxy.test.ts); the routes tested here refuse the input
// BEFORE any query, so no database is needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_PATTERN, containsNul, isEntityId, readJson } from "../lib/http";

const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("containsNul finds a NUL in any string, key, array item or depth, and nothing else", () => {
  assert.equal(containsNul("a\u0000b"), true);
  assert.equal(containsNul({ name: "ok", answers: { q1: ["fine", { deep: "x\u0000" }] } }), true);
  assert.equal(containsNul({ ["k\u0000"]: "v" }), true, "a key too");
  assert.equal(containsNul(["\u0000"]), true);
  for (const clean of ["", "plain", "tab\tnewline\n", "back\\u0000slash (the 6 characters, not a NUL)", { a: [1, true, null, { b: "c" }] }, 42, null, undefined]) {
    assert.equal(containsNul(clean), false, JSON.stringify(clean));
  }
});

test("readJson: the parsed body, or null for a body that is not JSON or holds a NUL anywhere", async () => {
  assert.deepEqual(await readJson(post("http://localhost/x", { a: 1, b: ["two"] })), { a: 1, b: ["two"] });
  assert.equal(await readJson(post("http://localhost/x", "{not json")), null);
  assert.equal(await readJson(post("http://localhost/x", "")), null);
  assert.equal(await readJson(post("http://localhost/x", { name: "A\u0000B" })), null, "\\u0000 in a field");
  assert.equal(await readJson(post("http://localhost/x", { answers: { q: ["x", { deep: "\u0000" }] } })), null, "deep inside");
  assert.deepEqual(await readJson(post("http://localhost/x", { text: "a\\u0000b" })), { text: "a\\u0000b" }, "backslash + u0000 typed as text is just text");
});

test("an entity id is letters, digits, underscore and hyphen, 1 to 64 long (a cuid passes, a NUL, a space or a path does not)", () => {
  for (const ok of ["cmuzpfpa80006hgvwwv85s7c7", "svc_1", "a-b_C9", "x".repeat(64)]) assert.equal(isEntityId(ok), true, ok);
  for (const bad of ["", "a\u0000b", "\u0000", "a b", "a/b", "../x", "a.b", "x".repeat(65), "é"]) assert.equal(isEntityId(bad), false, JSON.stringify(bad));
  assert.equal(isEntityId(null), false);
  assert.equal(isEntityId(undefined), false);
  assert.ok(ID_PATTERN.test("cmv38s5gc00000kvwgmy0j90l"));
});

test("GET /api/slots and /api/slots/days refuse a serviceId that is not an id (%00 included) with a 400, before any query", async () => {
  const slots = (await import("../app/api/slots/route")).GET;
  const days = (await import("../app/api/slots/days/route")).GET;
  for (const id of ["%00", "a%00b", "bad%20id", "..%2Fx", "x".repeat(65)]) {
    const a = await slots(new Request(`http://localhost/api/slots?serviceId=${id}&date=2026-10-12`));
    assert.equal(a.status, 400, `slots ${id}`);
    const b = await days(new Request(`http://localhost/api/slots/days?serviceId=${id}&from=2026-10-01&to=2026-10-31`));
    assert.equal(b.status, 400, `days ${id}`);
  }
  assert.equal((await slots(new Request("http://localhost/api/slots?date=2026-10-12"))).status, 400, "missing serviceId");
});

test("POST /api/bookings/hold and /api/checkout: a \\u0000 in any field is a 400, as is a serviceId or bookingId that is not an id", async () => {
  const hold = (await import("../app/api/bookings/hold/route")).POST;
  const checkout = (await import("../app/api/checkout/route")).POST;
  const body = { serviceId: "cmuzpfpa80006hgvwwv85s7c7", startTime: "2026-10-12T04:30:00.000Z", name: "QA", email: "qa@example.com", whatsapp: "+919999900001", whatsappOptIn: true, answers: { q1: "ok" } };
  for (const [label, bad] of [
    ["NUL in the name", { ...body, name: "A\u0000B" }],
    ["NUL in an answer", { ...body, answers: { q1: "x\u0000" } }],
    ["NUL in an answer key", { ...body, answers: { ["q\u0000"]: "x" } }],
    ["NUL in the service id", { ...body, serviceId: "svc\u0000" }],
    ["a service id that is a path", { ...body, serviceId: "../service" }],
  ] as Array<[string, unknown]>) {
    const res = await hold(post("http://localhost/api/bookings/hold", bad));
    assert.equal(res.status, 400, label);
  }
  // The refusal is the NUL's doing and not some other field: everything else in the body is valid (and a NUL in `name` passes the
  // schema by itself), so a 400 with a ROOT-level error ("expected an object") can only mean the whole body was thrown away.
  const nulName = await hold(post("http://localhost/api/bookings/hold", { ...body, name: "A\u0000B" }));
  const details = (await nulName.json()) as { details?: { formErrors?: unknown[] } };
  assert.ok((details.details?.formErrors?.length ?? 0) > 0, "the body was discarded, not parsed");
  for (const bookingId of ["a\u0000b", "../x", "x y", ""]) {
    assert.equal((await checkout(post("http://localhost/api/checkout", { bookingId }))).status, 400, JSON.stringify(bookingId));
  }
});
