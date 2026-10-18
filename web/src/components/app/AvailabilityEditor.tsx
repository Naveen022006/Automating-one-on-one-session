import { useRouter } from "@web/lib/navigate";
import { useMemo, useState } from "react";
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from "@web/components/icons";
import { useToast } from "@web/components/ui/overlays";
import { Alert, Button, Card, Field, Input, Select } from "@web/components/ui/primitives";
import { addMonths, daysInMonth, monthOf, todayIst, ymd } from "@web/components/ui/scheduling";
import { APP_TIME_ZONE, APP_TIME_ZONE_NOTE, formatClock, formatDay } from "@/lib/india";
import type { BlockedRow, RuleRow } from "@/lib/views/dashboard-types";
import { useApi } from "./ApiProvider";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

const label = formatClock;

/** Weekly grid editor: one row per weekday with its time ranges. */
export function WeeklyHours({ rules }: { rules: RuleRow[] }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [adding, setAdding] = useState<number | null>(null);
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("13:00");
  const [busy, setBusy] = useState(false);
  const byDay = useMemo(() => {
    const m = new Map<number, RuleRow[]>();
    for (const r of rules) m.set(r.weekday, [...(m.get(r.weekday) ?? []), r].sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return m;
  }, [rules]);
  // Hours saved before the product went India-only may still carry another zone: they keep their meaning until re-entered.
  const legacy = rules.filter((r) => r.timezone !== APP_TIME_ZONE);

  async function add(weekday: number) {
    if (end <= start) return toast("The end time must be after the start time.", "error");
    const overlaps = (byDay.get(weekday) ?? []).some((r) => start < r.endTime && end > r.startTime);
    if (overlaps) return toast("That overlaps hours you already have on this day.", "error");
    setBusy(true);
    const r = await api("/api/dashboard/availability", { body: { weekday, startTime: start, endTime: end } });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not add the hours.", "error");
    setAdding(null);
    router.refresh();
  }

  async function copyToWeekdays(weekday: number) {
    // Only IST hours are copied: a copy of an older rule in another zone would silently turn into IST.
    const source = (byDay.get(weekday) ?? []).filter((r) => r.timezone === APP_TIME_ZONE);
    if (source.length === 0) return toast("Those hours were saved in another time zone. Add them again to copy.", "error");
    setBusy(true);
    for (let d = 1; d <= 5; d++) {
      if (d === weekday || (byDay.get(d) ?? []).length > 0) continue;
      for (const r of source) await api("/api/dashboard/availability", { body: { weekday: d, startTime: r.startTime, endTime: r.endTime } });
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
    <Card title="Weekly hours" actions={<span className="subtle">{APP_TIME_ZONE_NOTE}</span>}>
      <div className="stack">
        {legacy.length > 0 && (
          <Alert tone="warning" title="Some hours were saved in another time zone">
            {legacy.length === 1 ? "One range below keeps" : `${legacy.length} ranges below keep`} the zone shown next to it, so customers still see the same moments as before. This service now works in Indian Standard Time only: remove the range and add it again to set it in IST. Days off are always Indian days, so a day you block also removes an older range whose time falls on that day in India.
          </Alert>
        )}
        {rules.length === 0 && <Alert tone="info" title="No hours yet">Add the times you are available each week. Customers can only book inside them.</Alert>}
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Weekly hours</caption>
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
                            {r.timezone !== APP_TIME_ZONE && <span className="subtle">{r.timezone.replace(/_/g, " ")}</span>}
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
export function BlockedDays({ blocked }: { blocked: BlockedRow[] }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const today = useMemo(() => todayIst(), []);
  const [month, setMonth] = useState(() => monthOf(today));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const set = new Map(blocked.map((b) => [b.date, b]));
  const firstDow = (new Date(Date.UTC(month.y, month.m - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array(firstDow).fill(null)];
  for (let d = 1; d <= daysInMonth(month.y, month.m); d++) cells.push(ymd(month.y, month.m, d));
  const label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.y, month.m - 1, 1)));
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
                      <span className="tabular">{formatDay(b.date, { weekday: false })}</span>
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
