import { useEffect, useMemo, useState } from "react";
import { IconCalendarClock, IconCalendarX, IconChevronLeft, IconDownload, IconVideo } from "@web/components/icons";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { ConfirmDialog } from "@web/components/ui/overlays";
import { Alert, Button, Card, StatusPill, cx } from "@web/components/ui/primitives";
import { Calendar, TimeSlotPicker, addMonths, daysInMonth, monthOf, todayIst, ymd, type SlotOption } from "@web/components/ui/scheduling";
import { ReceiptCard } from "@web/components/views/booking/ReceiptCard";
import { APP_TIME_ZONE_NOTE, formatDateTime, formatTime } from "@/lib/india";
import type { ManageBookingData } from "@/lib/views/booking-manage";

function when(iso: string) {
  return formatDateTime(new Date(iso));
}

export function ManageBooking({ data }: { data: ManageBookingData }) {
  const today = useMemo(() => todayIst(), []);
  const [status, setStatus] = useState(data.status);
  const [startTime, setStartTime] = useState(data.startTime);
  const [mode, setMode] = useState<"view" | "reschedule">("view");
  const [month, setMonth] = useState(() => monthOf(today));
  const [days, setDays] = useState<Set<string> | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (mode !== "reschedule") return;
    let cancelled = false;
    const first = ymd(month.y, month.m, 1);
    const from = first < today ? today : first;
    const to = ymd(month.y, month.m, daysInMonth(month.y, month.m));
    fetch(`/api/slots/days?${new URLSearchParams({ serviceId: data.serviceId, from, to })}`)
      .then((r) => r.json())
      .then((body) => !cancelled && setDays(new Set<string>(body.days ?? [])))
      .catch(() => !cancelled && setDays(null));
    return () => {
      cancelled = true;
    };
  }, [mode, month, today, data.serviceId]);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setSlots(null);
    setSlot(null);
    fetch(`/api/slots?${new URLSearchParams({ serviceId: data.serviceId, date })}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Could not load times");
        if (!cancelled) setSlots(body.slots);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [date, data.serviceId]);

  async function act(body: Record<string, unknown>) {
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
      if (!res.ok && res.status !== 202) throw new Error(result.error ?? "Something went wrong. Please try again.");
      return result as { warning?: string; refund?: { eligible: boolean; issued: "yes" | "pending" | "no" } };
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const result = await act({ action: "cancel" });
    setConfirmCancel(false);
    if (!result) return;
    setStatus("CANCELLED");
    setMode("view");
    setNotice(
      !result.refund?.eligible
        ? "Your booking is cancelled. A confirmation is on its way to your email."
        : result.refund.issued === "no"
          ? "Your booking is cancelled. You are due a full refund; the host has been notified and will issue it."
          : "Your booking is cancelled. Your refund is on its way and usually arrives within 5-7 working days.",
    );
  }

  async function reschedule() {
    if (!slot) return;
    const result = await act({ action: "reschedule", startTime: slot.start });
    if (!result) return;
    setStartTime(slot.start);
    setMode("view");
    setNotice(`Moved to ${when(slot.start)}. Your calendar invite and reminders were updated.`);
  }

  const cancelled = status === "CANCELLED";
  // A paid booking shows its printable receipt; printing the page then prints only the receipt (styles/print.css).
  const receipt = !cancelled ? data.receipt : null;

  return (
    <FocusedLayout>
      <div className={cx("stack stack--lg", receipt && "print-receipt-only")}>
        <div className="stack stack--sm">
          <h1 className="focused__title">Manage your booking</h1>
          <p className="muted">Hi {data.customerName}. {APP_TIME_ZONE_NOTE}</p>
        </div>

        {notice && <Alert tone="success">{notice}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}

        <Card>
          <div className="stack">
            <div className="row row--between">
              <h2 className="card__title">{data.serviceTitle}</h2>
              <StatusPill kind="booking" status={status} />
            </div>
            <dl className="summary">
              <dt>With</dt>
              <dd>{data.influencerName}</dd>
              <dt>When</dt>
              <dd>{when(startTime)}</dd>
              <dt>Where</dt>
              <dd>Google Meet</dd>
            </dl>
            {!cancelled && data.meetLink && (
              <div className="row">
                <a className="btn btn--primary" href={data.meetLink} target="_blank" rel="noopener noreferrer">
                  <IconVideo /> Join Google Meet
                </a>
                <a className="btn" href={`/api/bookings/${encodeURIComponent(data.bookingId)}/ics?t=${encodeURIComponent(data.token)}`}>
                  <IconDownload size={16} /> Add to calendar
                </a>
              </div>
            )}
          </div>
        </Card>

        {cancelled ? (
          <p className="muted">This booking is cancelled. To book again, visit {data.influencerName}&rsquo;s booking page.</p>
        ) : !data.canManage ? (
          <Alert tone="info">This booking can no longer be changed online. Please contact {data.influencerName}.</Alert>
        ) : mode === "view" ? (
          <div className="stack">
            <div className="grid grid--2">
              {data.canReschedule && (
                <button type="button" className="option" onClick={() => setMode("reschedule")} disabled={busy}>
                  <IconCalendarClock />
                  <span className="stack stack--sm">
                    <span className="option__title">Reschedule</span>
                    <span className="option__meta">Move to another open time. Free.</span>
                  </span>
                </button>
              )}
              <button type="button" className="option" onClick={() => setConfirmCancel(true)} disabled={busy}>
                <IconCalendarX />
                <span className="stack stack--sm">
                  <span className="option__title">Cancel booking</span>
                  <span className="option__meta">{data.refundPolicyText}</span>
                </span>
              </button>
            </div>
            {!data.canReschedule && (
              <p className="subtle">
                {data.hostSuspended
                  ? `Rescheduling is not available right now. You can still cancel this booking, or contact ${data.influencerName}.`
                  : data.serviceType === "GROUP"
                  ? "Rescheduling a group session is arranged by the host for everyone; contact them if the time does not work for you."
                  : "This session is less than 24 hours away, so it can no longer be rescheduled online. Contact the host if you need to change it."}
              </p>
            )}
          </div>
        ) : (
          <Card
            title={<h2 className="card__title">Pick a new time</h2>}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setMode("view")} disabled={busy}>
                <IconChevronLeft size={16} /> Back
              </Button>
            }
          >
            <div className="stack">
              <Calendar
                month={month}
                onMonthChange={(m) => {
                  setMonth(m);
                  setDays(null);
                }}
                value={date}
                onChange={setDate}
                availableDays={days}
                minDay={today}
                maxMonth={addMonths(monthOf(today).y, monthOf(today).m, 6)}
              />
              {date && <TimeSlotPicker slots={slots} value={slot?.start ?? null} onChange={setSlot} />}
              <div className="form-actions">
                <Button variant="primary" size="lg" onClick={reschedule} disabled={!slot} loading={busy}>
                  {slot ? `Move to ${formatTime(new Date(slot.start))} IST` : "Choose a time"}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {receipt && <ReceiptCard receipt={receipt} />}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancel}
        busy={busy}
        danger
        title="Cancel this booking?"
        description={`${data.serviceTitle} with ${data.influencerName}, ${when(startTime)}.`}
        confirmLabel="Cancel booking"
        cancelLabel="Keep my booking"
      >
        <p className="text-sm">{data.cancelRefundText ?? data.refundPolicyText}</p>
      </ConfirmDialog>
    </FocusedLayout>
  );
}
