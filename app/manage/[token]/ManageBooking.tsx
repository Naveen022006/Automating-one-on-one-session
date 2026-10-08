"use client";

import { useEffect, useMemo, useState } from "react";

export interface ManageBookingData {
  token: string;
  serviceId: string;
  serviceTitle: string;
  influencerName: string;
  influencerTimezone: string;
  customerName: string;
  status: string;
  startTime: string;
  endTime: string;
  meetLink: string | null;
  canManage: boolean;
}

interface Slot {
  start: string;
  end: string;
  seatsLeft: number;
}

function todayInTz(tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

export function ManageBooking({ data }: { data: ManageBookingData }) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [status, setStatus] = useState(data.status);
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [date, setDate] = useState(() => todayInTz(tz));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== "reschedule") return;
    let cancelled = false;
    setSlots(null);
    setSlot(null);
    const qs = new URLSearchParams({ serviceId: data.serviceId, date, tz });
    fetch(`/api/slots?${qs}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Could not load times");
        if (!cancelled) setSlots(body.slots);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [mode, date, tz, data.serviceId]);

  async function act(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/manage/${encodeURIComponent(data.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(result.error ?? "Something went wrong");
      setNotice(result.warning ? `${done} ${result.warning}` : done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm("Cancel this booking?")) return;
    if (await act({ action: "cancel" }, "Your booking was cancelled.")) {
      setStatus("CANCELLED");
      setMode("view");
    }
  }

  async function reschedule() {
    if (!slot) return;
    if (await act({ action: "reschedule", startTime: slot.start }, "Your booking was rescheduled.")) {
      setMode("view");
    }
  }

  if (status === "CANCELLED") {
    return (
      <main>
        <h1>Manage your booking</h1>
        <p className="muted">
          {data.serviceTitle} with {data.influencerName}
        </p>
        {notice && <p className="muted">{notice}</p>}
        <div className="card">
          <strong>This booking is cancelled.</strong>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Manage your booking</h1>
      <p className="muted">
        Hi {data.customerName}. Times shown in {tz}.
      </p>

      <div className="card">
        <strong>{data.serviceTitle}</strong>
        <div className="muted">with {data.influencerName}</div>
        <div className="muted">{formatWhen(data.startTime)}</div>
        <div className="muted">Status: {status}</div>
        {data.meetLink && (
          <div className="muted">
            Link:{" "}
            <a href={data.meetLink} target="_blank" rel="noreferrer">
              {data.meetLink}
            </a>
          </div>
        )}
      </div>

      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {!data.canManage ? (
        <p className="muted">This booking can no longer be changed online. Please contact {data.influencerName}.</p>
      ) : mode === "view" ? (
        <>
          <button className="choice" onClick={() => setMode("reschedule")} disabled={busy}>
            Reschedule
          </button>
          <button className="choice" onClick={cancel} disabled={busy}>
            Cancel booking
          </button>
        </>
      ) : (
        <>
          <h2>Pick a new time</h2>
          <input type="date" value={date} min={todayInTz(tz)} onChange={(e) => setDate(e.target.value)} />
          {slots === null && !error && <p className="muted">Loading…</p>}
          {slots?.length === 0 && <p className="muted">No times on this day.</p>}
          <div className="slots">
            {slots?.map((s) => (
              <button
                key={s.start}
                className="slot"
                aria-pressed={slot?.start === s.start}
                onClick={() => setSlot(s)}
              >
                {new Date(s.start).toLocaleTimeString(undefined, { timeStyle: "short" })}
              </button>
            ))}
          </div>
          <button className="primary" onClick={reschedule} disabled={busy || !slot}>
            {busy ? "Saving…" : "Confirm new time"}
          </button>
          <button className="choice" onClick={() => setMode("view")} disabled={busy}>
            Back
          </button>
        </>
      )}
    </main>
  );
}
