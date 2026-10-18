/**
 * Calendar-style date picker and grouped time-slot picker for the booking and self-service flows. Dates are plain
 * "YYYY-MM-DD" strings (Indian Standard Time days); times are rendered in IST (lib/india.ts). There is no time zone to choose.
 */
import { useMemo, useRef } from "react";
import { formatDay, formatTime, istParts, istToday } from "@/lib/india";
import { IconChevronLeft, IconChevronRight } from "@web/components/icons";
import { Button, Skeleton } from "./primitives";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}
export function ymd(y: number, m: number, d: number) {
  return `${y}-${pad(m)}-${pad(d)}`;
}
/** Today's date in India. */
export function todayIst(): string {
  return istToday();
}
export function monthOf(day: string): { y: number; m: number } {
  const [y, m] = day.split("-").map(Number);
  return { y, m };
}
export function addMonths(y: number, m: number, delta: number) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
export function daysInMonth(y: number, m: number) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function Calendar({
  month,
  onMonthChange,
  value,
  onChange,
  availableDays,
  loading,
  minDay,
  maxMonth,
}: {
  month: { y: number; m: number };
  onMonthChange: (next: { y: number; m: number }) => void;
  value: string | null;
  onChange: (day: string) => void;
  /** Days with open slots. Null while unknown (every future day is then selectable). */
  availableDays: ReadonlySet<string> | null;
  loading?: boolean;
  minDay: string;
  maxMonth?: { y: number; m: number };
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const { y, m } = month;
  const label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const total = daysInMonth(y, m);
  const min = monthOf(minDay);
  const canPrev = y * 12 + m > min.y * 12 + min.m;
  const canNext = !maxMonth || y * 12 + m < maxMonth.y * 12 + maxMonth.m;

  const cells = useMemo(() => {
    const out: (string | null)[] = Array(firstDow).fill(null);
    for (let d = 1; d <= total; d++) out.push(ymd(y, m, d));
    return out;
  }, [firstDow, total, y, m]);

  function focusDay(day: string) {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const current = (document.activeElement as HTMLElement | null)?.dataset?.day;
    if (!current) return;
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    const [cy, cm, cd] = current.split("-").map(Number);
    const next = new Date(Date.UTC(cy, cm - 1, cd + delta));
    const nextDay = ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    if (next.getUTCMonth() + 1 !== m) onMonthChange({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1 });
    requestAnimationFrame(() => focusDay(nextDay));
  }

  return (
    <div className="calendar">
      <div className="calendar__head">
        <Button variant="ghost" className="btn--icon" disabled={!canPrev} onClick={() => onMonthChange(addMonths(y, m, -1))} aria-label="Previous month">
          <IconChevronLeft />
        </Button>
        <span className="calendar__month" aria-live="polite">
          {label}
        </span>
        <Button variant="ghost" className="btn--icon" disabled={!canNext} onClick={() => onMonthChange(addMonths(y, m, 1))} aria-label="Next month">
          <IconChevronRight />
        </Button>
      </div>
      <div className="calendar__grid" role="grid" aria-label={label} ref={gridRef} onKeyDown={onKey}>
        {DOW.map((d) => (
          <div key={d} className="calendar__dow" role="columnheader" aria-label={d}>
            {d.slice(0, 2)}
          </div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <span key={`blank-${i}`} aria-hidden="true" />;
          const past = day < minDay;
          const available = !past && (availableDays ? availableDays.has(day) : true);
          const selected = value === day;
          return (
            <button
              key={day}
              type="button"
              className="calendar__day"
              data-day={day}
              data-available={available && !loading ? "true" : undefined}
              data-today={day === minDay ? "true" : undefined}
              aria-pressed={selected}
              aria-label={`${formatDay(day)}${available ? "" : ", no times available"}`}
              disabled={!available}
              tabIndex={selected || (!value && day === minDay) ? 0 : -1}
              onClick={() => onChange(day)}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export interface SlotOption {
  start: string;
  end: string;
  seatsLeft: number;
}

function partOfDay(iso: string): "Morning" | "Afternoon" | "Evening" {
  const h = istParts(new Date(iso)).hour;
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
}

export function TimeSlotPicker({
  slots,
  value,
  onChange,
  showSeats,
  loading,
}: {
  slots: SlotOption[] | null;
  value: string | null;
  onChange: (slot: SlotOption) => void;
  showSeats?: boolean;
  loading?: boolean;
}) {
  if (loading || slots === null) {
    return (
      <div className="slots" aria-busy="true" aria-label="Loading times">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={44} />
        ))}
      </div>
    );
  }
  if (slots.length === 0) return <p className="muted text-sm">No times left on this day. Pick another highlighted date.</p>;
  const groups = new Map<string, SlotOption[]>();
  for (const s of slots) {
    const g = partOfDay(s.start);
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  return (
    <div>
      {["Morning", "Afternoon", "Evening"]
        .filter((g) => groups.has(g))
        .map((g) => (
          <div key={g} className="slot-group" role="group" aria-label={g}>
            <p className="slot-group__label">{g}</p>
            <div className="slots">
              {groups.get(g)!.map((s) => (
                <button key={s.start} type="button" className="slot" aria-pressed={value === s.start} onClick={() => onChange(s)}>
                  <span>{formatTime(new Date(s.start))}</span>
                  {showSeats && <span className="slot__seats">{s.seatsLeft} left</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
