"use client";

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
  latestMessage: MessageView | null;
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

export interface DashboardData {
  influencerName: string;
  /** Signed dashboard token, carried through so FEAT-004 manual actions can call back without re-minting. */
  token: string;
  upcoming: SessionView[];
  past: SessionView[];
  earnings: EarningsSummary;
}

function formatPrice(minor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function messageLabel(m: MessageView | null): string {
  if (!m) return "not sent";
  return `${m.template} · ${m.channel} · ${m.status}`;
}

function BookingRow({ booking }: { booking: BookingView }) {
  return (
    <div className="card">
      <strong>{booking.customerName}</strong>
      <div className="muted">
        Booking {booking.status} · message: {messageLabel(booking.latestMessage)}
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
    </div>
  );
}

function SessionCard({ session }: { session: SessionView }) {
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
        session.bookings.map((b) => <BookingRow key={b.id} booking={b} />)
      )}
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
        data.upcoming.map((s) => <SessionCard key={s.id} session={s} />)
      )}

      <h2>Past sessions</h2>
      {data.past.length === 0 ? (
        <p className="muted">No past sessions.</p>
      ) : (
        data.past.map((s) => <SessionCard key={s.id} session={s} />)
      )}
    </main>
  );
}
