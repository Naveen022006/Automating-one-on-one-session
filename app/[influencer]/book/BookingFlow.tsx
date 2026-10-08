"use client";

import { useEffect, useMemo, useState } from "react";

interface ServiceView {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
}
interface Slot {
  start: string;
  end: string;
  seatsLeft: number;
}
interface HoldResult {
  bookingId: string;
  holdExpiresAt: string;
}

function formatPrice(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}

function todayInTz(tz: string) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export function BookingFlow({ services }: { services: ServiceView[] }) {
  // Times are stored in UTC; everything shown here is in the customer's own timezone.
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [service, setService] = useState<ServiceView | null>(null);
  const [date, setDate] = useState(() => todayInTz(tz));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hold, setHold] = useState<HoldResult | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    setSlots(null);
    setSlot(null);
    setError(null);
    const qs = new URLSearchParams({ serviceId: service.id, date, tz });
    fetch(`/api/slots?${qs}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Could not load slots");
        if (!cancelled) setSlots(data.slots);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [service, date, tz]);

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!service || !slot) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          startTime: slot.start,
          name,
          email,
          whatsapp,
          whatsappOptIn: optIn,
          tz,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not hold that slot");
        if (res.status === 409) setDate((d) => d); // slot gone: list refreshes on next pick
        return;
      }
      setNow(Date.now());
      setHold(data);
    } finally {
      setSubmitting(false);
    }
  }

  if (hold && slot && service) {
    const msLeft = new Date(hold.holdExpiresAt).getTime() - now;
    const expired = msLeft <= 0;
    const mm = Math.floor(Math.max(msLeft, 0) / 60000);
    const ss = Math.floor((Math.max(msLeft, 0) % 60000) / 1000);
    return (
      <div className="card">
        <h2>{expired ? "Your hold expired" : "Slot held for you"}</h2>
        <p>
          {service.title} on{" "}
          {new Date(slot.start).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
        </p>
        {expired ? (
          <button className="primary" onClick={() => { setHold(null); setSlot(null); setDate((d) => d); }}>
            Pick a time again
          </button>
        ) : (
          <>
            <p className="muted">
              Held for {mm}:{String(ss).padStart(2, "0")}. Payment is added in the next phase.
            </p>
            <p className="muted">Booking reference: {hold.bookingId}</p>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <h2>1. Service</h2>
      {services.length === 0 && <p className="muted">No services available yet.</p>}
      {services.map((s) => (
        <button key={s.id} className="choice" aria-pressed={service?.id === s.id} onClick={() => setService(s)}>
          <strong>{s.title}</strong> — {formatPrice(s.priceMinor, s.currency)}
          <div className="muted">
            {s.durationMin} min · {s.type === "GROUP" ? `group (up to ${s.capacity})` : "1:1"}
            {s.description ? ` · ${s.description}` : ""}
          </div>
        </button>
      ))}

      {service && (
        <>
          <h2>2. Date</h2>
          <input type="date" value={date} min={todayInTz(tz)} onChange={(e) => setDate(e.target.value)} />
          <p className="muted">Times shown in {tz}</p>

          <h2>3. Time</h2>
          {slots === null && !error && <p className="muted">Loading…</p>}
          {slots?.length === 0 && <p className="muted">No slots on this day.</p>}
          <div className="slots">
            {slots?.map((s) => (
              <button
                key={s.start}
                className="slot"
                aria-pressed={slot?.start === s.start}
                onClick={() => setSlot(s)}
              >
                {new Date(s.start).toLocaleTimeString(undefined, { timeStyle: "short" })}
                {service.type === "GROUP" ? ` (${s.seatsLeft} left)` : ""}
              </button>
            ))}
          </div>
        </>
      )}

      {slot && (
        <form onSubmit={submit}>
          <h2>4. Your details</h2>
          <label htmlFor="name">Name</label>
          <input id="name" type="text" required value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <label htmlFor="wa">WhatsApp number (with country code, e.g. +91 98765 43210)</label>
          <input id="wa" type="tel" required value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            <span>I agree to receive my meeting link and reminders on WhatsApp.</span>
          </label>
          <button className="primary" type="submit" disabled={submitting || !optIn}>
            {submitting ? "Holding…" : "Hold this slot"}
          </button>
        </form>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
