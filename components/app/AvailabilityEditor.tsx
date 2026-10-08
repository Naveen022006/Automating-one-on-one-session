"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from "@/components/icons";
import { useToast } from "@/components/ui/overlays";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui/primitives";
import { addMonths, daysInMonth, monthOf, timezoneOptions, todayIn, ymd } from "@/components/ui/scheduling";
import { useApi } from "./ApiProvider";

export interface RuleRow {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
}
export interface BlockedRow {
  id: string;
  date: string;
  reason: string | null;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

function label(t: string) {
  const [h, m] = t.split(":").map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
}

/** Weekly grid editor: one row per weekday with its time ranges. */
export function WeeklyHours({ rules, timezone }: { rules: RuleRow[]; timezone: string }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [tz, setTz] = useState(timezone);
  const [adding, setAdding] = useState<number | null>(null);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("13:00");
  const [busy, setBusy] = useState(false);
  const byDay = useMemo(() => {
    const m = new Map<number, RuleRow[]>();
    for (const r of rules) m.set(r.weekday, [...(m.get(r.weekday) ?? []), r].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return m;
  }, [rules]);
  const mixedZones = new Set(rules.map((r) => r.timezone)).size > 1;

  async function add(weekday: number) {
    if (end <= start) return toast("The end time must be after the start time.", "error");
    const overlaps = (byDay.get(weekday) ?? []).some((r) => start < r.endTime && end > r.startTime);
    if (overlaps) return toast("That overlaps hours you already have on this day.", "error");
    setBusy(true);
    const r = await api("/api/dashboard/availability", { body: { weekday, startTime: start, endTime: end, timezone: tz } });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not add the hours.", "error");
    setAdding(null);
    router.refresh();
  }

  async function copyToWeekdays(weekday: number) {
    const source = byDay.get(weekday) ?? [];
    if (source.length === 0) return;
    setBusy(true);
    for (let d = 1; d <= 5; d++) {
      if (d === weekday || (byDay.get(d) ?? []).length > 0) continue;
      for (const r of source) await api("/api/dashboard/availability", { body: { weekday: d, startTime: r.startTime, endTime: r.endTime, timezone: r.timezone } });
    }
    setBusy(false);
    toast("Copied to the empty weekdays.");
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(true);
    const r = await api("/api/dashboard/availability", { method: "DELETE", body: { ruleId: id } });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not remove the hours.", "error");
    router.refresh();
  }

  return (
    <Card
      title="Weekly hours"
      actions={
        <Field id="tz" label={<span className="sr-only">Time zone for new hours</span>}>
          <Select id="tz" value={tz} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTz(e.target.value)} style={{ minWidth: 220 }}>
            {timezoneOptions(tz).map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      }
    >
      <div className="stack">
        {mixedZones && <Alert tone="info">Some hours use a different time zone. Each range shows its own zone.</Alert>}
        {rules.length === 0 && <Alert tone="info" title="No hours yet">Add the times you are available each week. Customers can only book inside them.</Alert>}
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {WEEKDAYS.map((name, i) => {
                const weekday = i + 1;
                const ranges = byDay.get(weekday) ?? [];
                return (
                  <tr key={name}>
                    <th scope="row" style={{ width: 130, textTransform: "none", letterSpacing: 0, fontSize: "var(--text-sm)", color: "var(--text)", background: "transparent" }}>
                      {name}
                    </th>
                    <td>
                      <div className="stack stack--sm">
                        {ranges.length === 0 && adding !== weekday && <span className="subtle">Unavailable</span>}
                        {ranges.map((r) => (
                          <div key={r.id} className="row">
                            <span className="tabular">
                              {label(r.startTime)} – {label(r.endTime)}
                            </span>
                            {(mixedZones || r.timezone !== tz) && <span className="subtle">{r.timezone}</span>}
                            <Button variant="ghost" size="sm" className="btn--icon" aria-label={`Remove ${name} ${r.startTime} to ${r.endTime}`} onClick={() => remove(r.id)} disabled={busy}>
                              <IconTrash size={16} />
                            </Button>
                          </div>
                        ))}
                        {adding === weekday && (
                          <div className="row">
                            <Select aria-label="Start" value={start} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setStart(e.target.value)} style={{ width: 130 }}>
                              {TIMES.map((t) => (
                                <option key={t} value={t}>{label(t)}</option>
                              ))}
                            </Select>
                            <span aria-hidden="true">–</span>
                            <Select aria-label="End" value={end} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setEnd(e.target.value)} style={{ width: 130 }}>
                              {[...TIMES.slice(1), "23:59"].map((t) => (
                                <option key={t} value={t}>{t === "23:59" ? "Midnight" : label(t)}</option>
                              ))}
                            </Select>
                            <Button variant="primary" size="sm" onClick={() => add(weekday)} loading={busy}>
                              Add
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setAdding(null)}>
                              Cancel
                            </Button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ width: 1, whiteSpace: "nowrap" }}>
                      <div className="row row--end row--nowrap">
                        {adding !== weekday && (
                          <Button variant="ghost" size="sm" onClick={() => setAdding(weekday)} aria-label={`Add hours on ${name}`}>
                            <IconPlus size={16} /> Add
                          </Button>
                        )}
                        {ranges.length > 0 && weekday <= 5 && (
                          <Button variant="ghost" size="sm" onClick={() => copyToWeekdays(weekday)} disabled={busy}>
                            Copy to weekdays
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

/** Month calendar where a click blocks or unblocks a day. */
export function BlockedDays({ blocked, timezone }: { blocked: BlockedRow[]; timezone: string }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const today = useMemo(() => todayIn(timezone), [timezone]);
  const [month, setMonth] = useState(() => monthOf(today));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const set = new Map(blocked.map((b) => [b.date, b]));
  const firstDow = (new Date(Date.UTC(month.y, month.m - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(firstDow).fill(null)];
  for (let d = 1; d <= daysInMonth(month.y, month.m); d++) cells.push(ymd(month.y, month.m, d));
  const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.y, month.m - 1, 1)));
  const upcoming = blocked.filter((b) => b.date >= today);

  async function toggle(day: string) {
    setBusy(day);
    const existing = set.get(day);
    const r = existing
      ? await api("/api/dashboard/blocked-dates", { method: "DELETE", body: { blockedDateId: existing.id } })
      : await api("/api/dashboard/blocked-dates", { body: { date: day, reason: reason.trim() || undefined } });
    setBusy(null);
    if (!r.ok) return toast(r.data.error ?? "Could not update that day.", "error");
    toast(existing ? "Day unblocked." : "Day blocked. No new bookings can be made on it.");
    router.refresh();
  }

  return (
    <Card title="Days off">
      <div className="picker">
        <div className="calendar">
          <div className="calendar__head">
            <Button variant="ghost" className="btn--icon" aria-label="Previous month" disabled={month.y * 12 + month.m <= monthOf(today).y * 12 + monthOf(today).m} onClick={() => setMonth(addMonths(month.y, month.m, -1))}>
              <IconChevronLeft />
            </Button>
            <span className="calendar__month">{label}</span>
            <Button variant="ghost" className="btn--icon" aria-label="Next month" onClick={() => setMonth(addMonths(month.y, month.m, 1))}>
              <IconChevronRight />
            </Button>
          </div>
          <div className="calendar__grid">
            {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
              <div key={d} className="calendar__dow" aria-hidden="true">{d}</div>
            ))}
            {cells.map((day, i) =>
              day ? (
                <button
                  key={day}
                  type="button"
                  className="calendar__day"
                  data-available={day >= today ? "true" : undefined}
                  aria-pressed={set.has(day)}
                  aria-label={`${day}${set.has(day) ? ", blocked. Press to unblock" : ". Press to block"}`}
                  disabled={day < today || busy !== null}
                  onClick={() => toggle(day)}
                  style={set.has(day) ? { background: "var(--danger)", color: "#fff" } : undefined}
                >
                  {Number(day.slice(8))}
                </button>
              ) : (
                <span key={`b${i}`} />
              ),
            )}
          </div>
        </div>
        <div className="stack">
          <Field id="block-reason" label="Reason" optional help="Only you see this. Applied to the next day you block.">
            <Input id="block-reason" value={reason} maxLength={200} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)} placeholder="Holiday" />
          </Field>
          <div>
            <p className="field__label" style={{ marginBottom: 8 }}>Upcoming days off</p>
            {upcoming.length === 0 ? (
              <p className="subtle">None. Click a day in the calendar to block it.</p>
            ) : (
              <ul className="stack stack--sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {upcoming.map((b) => (
                  <li key={b.id} className="row row--between">
                    <span>
                      <span className="tabular">
                        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${b.date}T12:00:00Z`))}
                      </span>
                      {b.reason && <span className="subtle"> · {b.reason}</span>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => toggle(b.date)} loading={busy === b.date}>
                      Unblock
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="subtle">Blocking a day stops new bookings. Existing bookings on that day are not cancelled.</p>
        </div>
      </div>
    </Card>
  );
}
