import assert from "node:assert/strict";
import { test } from "node:test";
import { toE164 } from "../lib/phone";
import { dayBoundsUtc, generateSlots, isSlotStart, type Rule } from "../lib/slots";

const IST = "Asia/Kolkata";
const monday: Rule = { weekday: 1, startTime: "10:00", endTime: "12:00", timezone: IST };

test("generates back-to-back slots inside the window, in UTC", () => {
  // Monday 2030-01-07, 10:00-12:00 IST = 04:30-06:30 UTC
  const from = new Date("2030-01-07T00:00:00Z");
  const to = new Date("2030-01-08T00:00:00Z");
  const slots = generateSlots([monday], 30, from, to).map((d) => d.toISOString());
  assert.deepEqual(slots, [
    "2030-01-07T04:30:00.000Z",
    "2030-01-07T05:00:00.000Z",
    "2030-01-07T05:30:00.000Z",
    "2030-01-07T06:00:00.000Z",
  ]);
});

test("a slot that would overrun the window is dropped", () => {
  const from = new Date("2030-01-07T00:00:00Z");
  const to = new Date("2030-01-08T00:00:00Z");
  assert.equal(generateSlots([monday], 45, from, to).length, 2); // 10:00, 10:45; 11:30 overruns
});

test("other weekdays produce nothing", () => {
  const from = new Date("2030-01-08T00:00:00Z"); // Tuesday
  const to = new Date("2030-01-09T00:00:00Z");
  assert.equal(generateSlots([monday], 30, from, to).length, 0);
});

test("customer day bounds cut across the influencer's day correctly", () => {
  // Customer in New York asks for 2030-01-06 (Sunday there): 05:00Z Jan 6 -> 05:00Z Jan 7.
  // Monday 10:00 IST = 04:30Z Jan 7, which is still Sunday evening in New York.
  const b = dayBoundsUtc("2030-01-06", "America/New_York")!;
  const slots = generateSlots([monday], 30, b.from, b.to);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].toISOString(), "2030-01-07T04:30:00.000Z");
});

test("isSlotStart accepts real starts only", () => {
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T05:00:00Z")), true);
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T05:10:00Z")), false);
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T07:00:00Z")), false);
});

test("phone numbers are validated and normalised to E.164", () => {
  assert.equal(toE164("98765 43210"), "+919876543210");
  assert.equal(toE164("+1 415 555 2671"), "+14155552671");
  assert.equal(toE164("12345"), null);
  assert.equal(toE164("not a number"), null);
});
