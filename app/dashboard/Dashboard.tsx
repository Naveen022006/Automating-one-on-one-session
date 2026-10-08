"use client";

import { useState } from "react";
import type { EarningsSummary } from "@/lib/dashboard";

export interface MessageView {
  channel: string;
  template: string;
  status: string;
}

export interface BookingView {
  id: string;
  customerName: string;
  status: string;
  meetLink: string | null;
  lastError: string | null;
  /** Latest message per channel (so a queued whatsapp row never hides a failed email on the same booking). */
  messages: MessageView[];
}

export interface SessionView {
  id: string;
  serviceTitle: string;
  serviceType: "ONE_TO_ONE" | "GROUP";
  startTime: string;
  endTime: string;
  capacity: number;
  seatsFilled: number;
  meetLink: string | null;
  bookings: BookingView[];
}

export interface ServiceAdminView {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
  active: boolean;
}

export interface RuleView {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timezone: string;
}

export interface BlockedDateView {
  id: string;
  date: string;
  reason: string | null;
}

export interface DashboardData {
  influencerName: string;
  influencerTimezone: string;
  /** Signed dashboard token, carried through so manual actions can call back without re-minting. */
  token: string;
  upcoming: SessionView[];
  past: SessionView[];
  earnings: EarningsSummary;
  services: ServiceAdminView[];
  rules: RuleView[];
  blockedDates: BlockedDateView[];
}

const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatPrice(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function messagesLabel(messages: MessageView[]): string {
  if (messages.length === 0) return "not sent";
  // One entry per channel so a failed email is not hidden behind a later queued whatsapp row.
  return messages.map((m) => `${m.template} · ${m.channel} · ${m.status}`).join(" | ");
}

/** Shared helper: POST JSON to a dashboard route, reporting a message. Reloads on success so views refresh. */
async function callApi(url: string, method: string, body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) return data.error ?? "Request failed";
  return data.warning ? `Done. ${data.warning}` : null;
}

function BookingRow({ booking, token }: { booking: BookingView; token: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const manageable = booking.status === "PAID" || booking.status === "SCHEDULED";

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const err = await callApi(`/api/dashboard/bookings/${encodeURIComponent(booking.id)}`, "POST", { token, ...body });
    setBusy(false);
    if (err) {
      setMsg(err);
    } else {
      window.location.reload();
    }
  }

  async function reschedule() {
    const value = prompt("New start time (ISO 8601, e.g. 2030-01-07T05:00:00Z)");
    if (!value) return;
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) {
      setMsg("Invalid date/time");
      return;
    }
    await run({ action: "reschedule", startTime: when.toISOString() });
  }

  return (
    <div className="card">
      <strong>{booking.customerName}</strong>
      <div className="muted">
        Booking {booking.status} · message: {messagesLabel(booking.messages)}
      </div>
      {booking.meetLink && (
        <div className="muted">
          Link:{" "}
          <a href={booking.meetLink} target="_blank" rel="noreferrer">
            {booking.meetLink}
          </a>
        </div>
      )}
      {booking.lastError && <div className="error">{booking.lastError}</div>}
      <div className="slots">
        <button className="slot" disabled={busy} onClick={() => run({ action: "resend" })}>
          Resend link
        </button>
        {manageable && (
          <>
            <button className="slot" disabled={busy} onClick={reschedule}>
              Reschedule
            </button>
            <button className="slot" disabled={busy} onClick={() => run({ action: "cancel" })}>
              Cancel
            </button>
          </>
        )}
      </div>
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}

function SessionCard({ session, token }: { session: SessionView; token: string }) {
  const seats =
    session.serviceType === "GROUP"
      ? `${session.seatsFilled} / ${session.capacity} seats`
      : `${session.seatsFilled} booked`;
  return (
    <div className="card">
      <strong>{session.serviceTitle}</strong>
      <div className="muted">
        {formatWhen(session.startTime)} · {seats}
      </div>
      {session.meetLink && (
        <div className="muted">
          Shared link:{" "}
          <a href={session.meetLink} target="_blank" rel="noreferrer">
            {session.meetLink}
          </a>
        </div>
      )}
      {session.bookings.length === 0 ? (
        <p className="muted">No bookings yet.</p>
      ) : (
        session.bookings.map((b) => <BookingRow key={b.id} booking={b} token={token} />)
      )}
    </div>
  );
}

function ServicesManager({ data }: { data: DashboardData }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [durationMin, setDurationMin] = useState("30");
  const [priceMinor, setPriceMinor] = useState("50000");
  const [type, setType] = useState<"ONE_TO_ONE" | "GROUP">("ONE_TO_ONE");
  const [capacity, setCapacity] = useState("1");

  async function add() {
    setBusy(true);
    setMsg(null);
    const err = await callApi("/api/dashboard/services", "POST", {
      token: data.token,
      title,
      durationMin: Number(durationMin),
      priceMinor: Number(priceMinor),
      type,
      capacity: Number(capacity),
    });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  async function toggle(s: ServiceAdminView) {
    setBusy(true);
    const err = await callApi("/api/dashboard/services", "PATCH", {
      token: data.token,
      serviceId: s.id,
      active: !s.active,
    });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  return (
    <div className="card">
      {data.services.map((s) => (
        <div key={s.id} className="muted">
          {s.title} — {formatPrice(s.priceMinor, s.currency)} · {s.durationMin} min ·{" "}
          {s.type === "GROUP" ? `group (${s.capacity})` : "1:1"} · {s.active ? "active" : "inactive"}{" "}
          <button className="slot" disabled={busy} onClick={() => toggle(s)}>
            {s.active ? "Deactivate" : "Activate"}
          </button>
        </div>
      ))}
      <h2>Add a service</h2>
      <label htmlFor="svc-title">Title</label>
      <input id="svc-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="svc-duration">Duration (minutes)</label>
      <input id="svc-duration" type="text" value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
      <label htmlFor="svc-price">Price (minor units, e.g. paise/cents)</label>
      <input id="svc-price" type="text" value={priceMinor} onChange={(e) => setPriceMinor(e.target.value)} />
      <label className="check">
        <input
          type="checkbox"
          checked={type === "GROUP"}
          onChange={(e) => setType(e.target.checked ? "GROUP" : "ONE_TO_ONE")}
        />
        <span>Group session</span>
      </label>
      {type === "GROUP" && (
        <>
          <label htmlFor="svc-capacity">Capacity</label>
          <input id="svc-capacity" type="text" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </>
      )}
      <button className="primary" disabled={busy || !title} onClick={add}>
        Add service
      </button>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

function AvailabilityManager({ data }: { data: DashboardData }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [weekday, setWeekday] = useState("1");
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("12:00");
  const [timezone, setTimezone] = useState(data.influencerTimezone);

  async function add() {
    setBusy(true);
    setMsg(null);
    const err = await callApi("/api/dashboard/availability", "POST", {
      token: data.token,
      weekday: Number(weekday),
      startTime,
      endTime,
      timezone,
    });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const err = await callApi("/api/dashboard/availability", "DELETE", { token: data.token, ruleId: id });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  return (
    <div className="card">
      {data.rules.length === 0 && <p className="muted">No weekly availability yet.</p>}
      {data.rules.map((r) => (
        <div key={r.id} className="muted">
          {WEEKDAYS[r.weekday]} {r.startTime}–{r.endTime} ({r.timezone}){" "}
          <button className="slot" disabled={busy} onClick={() => remove(r.id)}>
            Delete
          </button>
        </div>
      ))}
      <h2>Add a weekly rule</h2>
      <label htmlFor="rule-weekday">Weekday (1=Mon … 7=Sun)</label>
      <input id="rule-weekday" type="text" value={weekday} onChange={(e) => setWeekday(e.target.value)} />
      <label htmlFor="rule-start">Start (HH:mm)</label>
      <input id="rule-start" type="text" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
      <label htmlFor="rule-end">End (HH:mm)</label>
      <input id="rule-end" type="text" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
      <label htmlFor="rule-tz">Timezone</label>
      <input id="rule-tz" type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
      <button className="primary" disabled={busy} onClick={add}>
        Add rule
      </button>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

function BlockedDatesManager({ data }: { data: DashboardData }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");

  async function add() {
    setBusy(true);
    setMsg(null);
    const err = await callApi("/api/dashboard/blocked-dates", "POST", {
      token: data.token,
      date,
      reason: reason || undefined,
    });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const err = await callApi("/api/dashboard/blocked-dates", "DELETE", { token: data.token, blockedDateId: id });
    setBusy(false);
    if (err) setMsg(err);
    else window.location.reload();
  }

  return (
    <div className="card">
      {data.blockedDates.length === 0 && <p className="muted">No blocked days.</p>}
      {data.blockedDates.map((b) => (
        <div key={b.id} className="muted">
          {b.date}
          {b.reason ? ` — ${b.reason}` : ""}{" "}
          <button className="slot" disabled={busy} onClick={() => remove(b.id)}>
            Unblock
          </button>
        </div>
      ))}
      <h2>Block a day</h2>
      <label htmlFor="block-date">Date</label>
      <input id="block-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <label htmlFor="block-reason">Reason (optional)</label>
      <input id="block-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="primary" disabled={busy || !date} onClick={add}>
        Block day
      </button>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

export function Dashboard({ data }: { data: DashboardData }) {
  const { earnings } = data;
  return (
    <main>
      <h1>{data.influencerName}&rsquo;s dashboard</h1>
      <p className="muted">Your sessions, bookings and earnings. Times shown in your browser timezone.</p>

      <h2>Earnings</h2>
      {earnings.totalsByCurrency.length === 0 ? (
        <p className="muted">No captured payments yet.</p>
      ) : (
        <div className="card">
          {earnings.totalsByCurrency.map((t) => (
            <div key={t.currency}>
              <strong>Total: {formatPrice(t.amountMinor, t.currency)}</strong>
            </div>
          ))}
          <div className="muted">By service</div>
          {earnings.byService.map((s) => (
            <div key={`${s.serviceId}:${s.currency}`} className="muted">
              {s.serviceTitle}: {formatPrice(s.amountMinor, s.currency)} ({s.count})
            </div>
          ))}
        </div>
      )}

      <h2>Upcoming sessions</h2>
      {data.upcoming.length === 0 ? (
        <p className="muted">No upcoming sessions.</p>
      ) : (
        data.upcoming.map((s) => <SessionCard key={s.id} session={s} token={data.token} />)
      )}

      <h2>Past sessions</h2>
      {data.past.length === 0 ? (
        <p className="muted">No past sessions.</p>
      ) : (
        data.past.map((s) => <SessionCard key={s.id} session={s} token={data.token} />)
      )}

      <h2>Services</h2>
      <ServicesManager data={data} />

      <h2>Weekly availability</h2>
      <AvailabilityManager data={data} />

      <h2>Blocked days</h2>
      <BlockedDatesManager data={data} />
    </main>
  );
}
