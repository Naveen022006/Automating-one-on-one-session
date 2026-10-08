import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedDaySet, generateSlots, isSlotStart, type Rule } from "../lib/slots";

const IST = "Asia/Kolkata";
const monday: Rule = { weekday: 1, startTime: "10:00", endTime: "12:00", timezone: IST };

test("a blocked day removes all of its slots from generateSlots", () => {
  // Monday 2030-01-07, 10:00-12:00 IST = 04:30-06:30 UTC. Four 30-min slots when open.
  const from = new Date("2030-01-07T00:00:00Z");
  const to = new Date("2030-01-08T00:00:00Z");
  assert.equal(generateSlots([monday], 30, from, to).length, 4);

  const blocked = new Set(["2030-01-07"]);
  assert.deepEqual(generateSlots([monday], 30, from, to, blocked), []);
});

test("blocking one day does not affect other days", () => {
  // Two consecutive Mondays; block only the first.
  const from = new Date("2030-01-07T00:00:00Z");
  const to = new Date("2030-01-15T00:00:00Z");
  const open = generateSlots([monday], 30, from, to);
  assert.equal(open.length, 8); // 4 slots on each Monday

  const blocked = new Set(["2030-01-07"]);
  const remaining = generateSlots([monday], 30, from, to, blocked).map((d) => d.toISOString());
  // Only the second Monday (2030-01-14) survives.
  assert.deepEqual(remaining, [
    "2030-01-14T04:30:00.000Z",
    "2030-01-14T05:00:00.000Z",
    "2030-01-14T05:30:00.000Z",
    "2030-01-14T06:00:00.000Z",
  ]);
});

test("isSlotStart rejects a real start that falls on a blocked day", () => {
  const start = new Date("2030-01-07T05:00:00Z");
  assert.equal(isSlotStart([monday], 30, start), true);
  assert.equal(isSlotStart([monday], 30, start, new Set(["2030-01-07"])), false);
});

test("blockedDaySet maps stored UTC-midnight dates back to YYYY-MM-DD", () => {
  const set = blockedDaySet([new Date("2030-01-07T00:00:00Z")]);
  assert.ok(set.has("2030-01-07"));
  assert.equal(set.has("2030-01-08"), false);
});
