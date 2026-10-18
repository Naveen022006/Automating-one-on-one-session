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

test("the customer's day is the Indian day: 00:00 IST is 18:30 UTC the evening before", () => {
  // Before the India-only change a customer in New York asked for 2030-01-06 in their own zone (05:00Z -> 05:00Z) and the Monday
  // 10:00 IST slot (04:30Z Jan 7) belonged to THEIR Sunday. Now every day is an IST day: that slot is on Monday 2030-01-07 and nowhere else.
  const sunday = dayBoundsUtc("2030-01-06")!;
  assert.equal(sunday.from.toISOString(), "2030-01-05T18:30:00.000Z");
  assert.equal(sunday.to.toISOString(), "2030-01-06T18:30:00.000Z");
  assert.equal(generateSlots([monday], 30, sunday.from, sunday.to).length, 0);
  const b = dayBoundsUtc("2030-01-07")!;
  const slots = generateSlots([monday], 30, b.from, b.to);
  assert.equal(slots.length, 4);
  assert.equal(slots[0].toISOString(), "2030-01-07T04:30:00.000Z");
  assert.equal(dayBoundsUtc("2030-02-31"), null);
});

test("isSlotStart accepts real starts only", () => {
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T05:00:00Z")), true);
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T05:10:00Z")), false);
  assert.equal(isSlotStart([monday], 30, new Date("2030-01-07T07:00:00Z")), false);
});

test("phone numbers are validated and normalised to E.164 (Indian mobiles only; the full matrix is in tests/india.test.ts)", () => {
  assert.equal(toE164("98765 43210"), "+919876543210");
  assert.equal(toE164("+1 415 555 2671"), null, "another country is refused");
  assert.equal(toE164("12345"), null);
  assert.equal(toE164("not a number"), null);
});

test("an IST day has no daylight saving: the same wall-clock time is the same UTC time all year", () => {
  const evening: Rule = { weekday: 7, startTime: "18:00", endTime: "19:00", timezone: IST };
  // Sundays around the dates on which Europe and the US change their clocks.
  for (const day of ["2030-03-24", "2030-03-31", "2030-10-27", "2030-11-03", "2030-07-14"]) {
    const b = dayBoundsUtc(day)!;
    const slots = generateSlots([evening], 60, b.from, b.to);
    assert.deepEqual(slots.map((s) => s.toISOString()), [`${day}T12:30:00.000Z`], day);
  }
});

test("a window that starts at midnight IST begins 18:30 UTC the evening before", () => {
  const lateNight: Rule = { weekday: 1, startTime: "00:00", endTime: "01:00", timezone: IST };
  const b = dayBoundsUtc("2030-01-07")!;
  assert.deepEqual(generateSlots([lateNight], 30, b.from, b.to).map((s) => s.toISOString()), ["2030-01-06T18:30:00.000Z", "2030-01-06T19:00:00.000Z"]);
});

test("a rule saved in another zone before the change keeps producing its own instants (the stored zone is honoured)", () => {
  const newYork: Rule = { weekday: 1, startTime: "10:00", endTime: "11:00", timezone: "America/New_York" };
  const winter = generateSlots([newYork], 60, new Date("2030-01-06T00:00:00Z"), new Date("2030-01-09T00:00:00Z")).map((s) => s.toISOString());
  const summer = generateSlots([newYork], 60, new Date("2030-07-07T00:00:00Z"), new Date("2030-07-10T00:00:00Z")).map((s) => s.toISOString());
  assert.deepEqual(winter, ["2030-01-07T15:00:00.000Z"]);
  assert.deepEqual(summer, ["2030-07-08T14:00:00.000Z"], "daylight saving moves it an hour: this is why such a rule is not converted automatically");
});
