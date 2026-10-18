import { useRouter } from "@web/lib/navigate";
import { useEffect, useMemo, useState } from "react";
import { IconCalendarClock, IconCalendarX, IconCopy, IconSend, IconUndo, IconUsers, IconVideo } from "@web/components/icons";
import { ConfirmDialog, CopyField, Dialog, Drawer, useToast } from "@web/components/ui/overlays";
import { Alert, Badge, Button, EmptyState, Field, Input, Skeleton, StatusPill, Textarea } from "@web/components/ui/primitives";
import { Calendar, TimeSlotPicker, addMonths, daysInMonth, monthOf, todayIst, ymd, type SlotOption } from "@web/components/ui/scheduling";
import { formatMoney } from "@/lib/format";
import { APP_TIME_ZONE_NOTE, formatDateTime, formatIndianMobile } from "@/lib/india";
import type { BookingDetail, BookingRow, SessionRow } from "@/lib/dashboard-data";
import { isUnconfirmedMessage, QR_CHANNEL_LABEL, UNCONFIRMED_MESSAGE_TEXT } from "@web/lib/whatsapp-web-ui";
import { useApi } from "./ApiProvider";

const CHANNEL: Record<string, string> = { WHATSAPP: "WhatsApp", WHATSAPP_WEB: QR_CHANNEL_LABEL, SMS: "SMS", EMAIL: "Email", LOG: "Log" };
const TEMPLATE: Record<string, string> = {
  "booking-confirmation": "Confirmation",
  "reminder-24h": "24 h reminder",
  "reminder-15m": "15 min reminder",
  reschedule: "Reschedule notice",
  "booking-rescheduled": "Reschedule email",
  cancellation: "Cancellation notice",
  "booking-cancelled": "Cancellation email",
  receipt: "Receipt",
};
const POLICY: Record<string, string> = { FULL: "Full refund", NOTICE_24H: "Refund with 24 h notice", NONE: "No refund" };

export const money = formatMoney;
/** "Sat, 25 Oct, 6:30 PM IST": every time on the dashboard is Indian Standard Time. */
export function dateTime(iso: string) {
  return formatDateTime(new Date(iso), { year: false });
}

function MessageSummary({ booking }: { booking: BookingRow }) {
  if (booking.latestByChannel.length === 0) return <span className="subtle">No messages yet</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {booking.latestByChannel
        .filter((m) => m.channel !== "LOG")
        .map((m) => (
          <span key={m.channel} title={`${TEMPLATE[m.template] ?? m.template}${isUnconfirmedMessage(m) ? `: ${UNCONFIRMED_MESSAGE_TEXT}` : m.error ? `: ${m.error}` : ""}`}>
            <span className="subtle">{CHANNEL[m.channel] ?? m.channel}</span> {isUnconfirmedMessage(m) ? <Badge tone="warning">Not confirmed</Badge> : <StatusPill kind="message" status={m.status} />}
          </span>
        ))}
    </span>
  );
}

export function SessionsBoard({
  sessions,
  emptyTitle,
  emptyBody,
  initialBookingId,
}: {
  sessions: SessionRow[];
  emptyTitle: string;
  emptyBody: string;
  initialBookingId?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(initialBookingId ?? null);
  if (sessions.length === 0) {
    return <EmptyState icon={<IconCalendarClock />} title={emptyTitle}>{emptyBody}</EmptyState>;
  }
  return (
    <>
      <div className="table-wrap">
        <table className="table table--stack">
          <caption className="sr-only">Bookings</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Session</th>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col">Messages</th>
            </tr>
          </thead>
          <tbody>
            {sessions.flatMap((s) =>
              s.bookings.map((b, i) => (
                <tr
                  key={b.id}
                  data-clickable
                  tabIndex={0}
                  onClick={() => setOpen(b.id)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLTableRowElement>) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(b.id))}
                  aria-label={`${b.customerName}, ${s.serviceTitle}, ${dateTime(s.startTime)}. Open details`}
                >
                  <td data-label="When" className="tabular">
                    {i === 0 || s.serviceType !== "GROUP" ? dateTime(s.startTime) : ""}
                  </td>
                  <td data-label="Session">
                    <span className="row row--nowrap" style={{ gap: 8 }}>
                      {s.serviceType === "GROUP" ? <IconUsers size={16} /> : <IconVideo size={16} />}
                      <span>
                        {s.serviceTitle}
                        {s.serviceType === "GROUP" && i === 0 && (
                          <span className="subtle">
                            {" "}
                            · {s.seatsFilled}/{s.capacity} seats
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td data-label="Customer">
                    <div style={{ fontWeight: 600 }}>{b.customerName}</div>
                    {b.lastError && <div className="error-text">Needs attention</div>}
                    {b.payment?.needsRefund && b.payment.status === "CAPTURED" && <Badge tone="warning">Refund due</Badge>}
                  </td>
                  <td data-label="Status">
                    <StatusPill kind="booking" status={b.status} />
                  </td>
                  <td data-label="Messages">
                    <MessageSummary booking={b} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <BookingDrawer bookingId={open} onClose={() => setOpen(null)} />
    </>
  );
}

function BookingDrawer({ bookingId, onClose }: { bookingId: string | null; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const router = useRouter();
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"cancel" | "refund" | "reschedule" | "decline" | null>(null);
  const [reason, setReason] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [payLink, setPayLink] = useState<string | null>(null);

  useEffect(() => {
    if (!bookingId) return;
    setDetail(null);
    setError(null);
    api<BookingDetail>(`/api/dashboard/bookings/${encodeURIComponent(bookingId)}`).then((r) => {
      if (r.ok) setDetail(r.data as BookingDetail);
      else setError(r.data.error ?? "Could not load the booking");
    });
  }, [bookingId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(label: string, url: string, body: Record<string, unknown>, done: string) {
    setBusy(label);
    const r = await api(url, { body });
    setBusy(null);
    if (!r.ok && r.status !== 202) {
      toast(r.data.error ?? "That did not work. Please try again.", "error");
      return false;
    }
    // An approval says whether the customer was e-mailed the payment link. With no Gmail connection and no platform e-mail (doc/15) nothing
    // went out, so the link is shown to the host to send themselves: never "was emailed" for a message that was not sent.
    if (label === "approve" && r.data.emailed === false) {
      toast("Approved, but the customer could not be e-mailed. Send them the payment link yourself.", "error");
      if (typeof r.data.payLink === "string") setPayLink(r.data.payLink);
    } else toast(r.data.warning ? `${done} ${r.data.warning}` : done);
    setDialog(null);
    router.refresh();
    if (bookingId) {
      const fresh = await api<BookingDetail>(`/api/dashboard/bookings/${encodeURIComponent(bookingId)}`);
      if (fresh.ok) setDetail(fresh.data as BookingDetail);
    }
    return true;
  }

  const live = detail && (detail.status === "PAID" || detail.status === "SCHEDULED");
  const captured = detail?.payments.find((p) => p.status === "CAPTURED") ?? null;
  const refundable = captured ? captured.amountMinor - (captured.refundAmountMinor ?? 0) : 0;
  const refundInFlight = captured?.refundStatus === "requested";

  return (
    <Drawer
      open={bookingId !== null}
      onClose={onClose}
      title={detail ? detail.customerName : "Booking"}
      subtitle={detail ? `${detail.session.serviceTitle} · ${dateTime(detail.session.startTime)}` : undefined}
      footer={
        detail && (
          <>
            {detail.status === "REQUESTED" && (
              <>
                <Button
                  variant="primary"
                  onClick={() => run("approve", `/api/dashboard/bookings/${detail.id}/decision`, { action: "approve" }, "Approved. The customer was emailed a link to pay.")}
                  loading={busy === "approve"}
                >
                  Approve request
                </Button>
                <Button variant="danger" onClick={() => setDialog("decline")}>
                  Decline
                </Button>
              </>
            )}
            {(live || detail.status === "COMPLETED") && (
              <Button onClick={() => run("resend", `/api/dashboard/bookings/${detail.id}`, { action: "resend" }, "Link sent again.")} loading={busy === "resend"}>
                <IconSend size={16} /> Resend link
              </Button>
            )}
            {live && (
              <Button onClick={() => setDialog("reschedule")}>
                <IconCalendarClock size={16} /> Reschedule
              </Button>
            )}
            {live && (
              <Button variant="danger" onClick={() => setDialog("cancel")}>
                <IconCalendarX size={16} /> Cancel
              </Button>
            )}
            {captured && refundable > 0 && (
              <Button
                variant="danger"
                disabled={refundInFlight}
                title={refundInFlight ? "Waiting for Razorpay to confirm the last refund" : undefined}
                onClick={() => (setRefundAmount((refundable / 100).toFixed(2)), setDialog("refund"))}
              >
                <IconUndo size={16} /> {captured.refundAmountMinor ? "Refund the rest" : "Refund"}
              </Button>
            )}
          </>
        )
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {!detail && !error && (
        <div className="stack">
          <Skeleton height={20} width="60%" />
          <Skeleton height={80} />
          <Skeleton height={120} />
        </div>
      )}
      {detail && (
        <div className="stack stack--lg">
          {detail.lastError && (
            <Alert tone="danger" title="Needs attention">
              {detail.lastError}
            </Alert>
          )}
          {captured?.needsRefund && (
            <Alert tone="warning" title="Refund due">
              This booking was cancelled and its payment should be refunded.
            </Alert>
          )}
          {detail.status === "REQUESTED" && (
            <Alert tone="warning" title="Waiting for your answer">
              This customer asked to book. The time is held for them{detail.requestExpiresAt ? ` until ${dateTime(detail.requestExpiresAt)}` : ""}. Approve to let them pay, or decline. Nothing has been charged.
            </Alert>
          )}
          {detail.status === "CANCELLED" && detail.declineReason && (
            <Alert tone="info" title="You declined this request">
              Reason given to the customer: {detail.declineReason}
            </Alert>
          )}
          <section className="stack stack--sm" aria-label="Status">
            <div className="row">
              <StatusPill kind="booking" status={detail.status} />
              <Badge plain>{POLICY[detail.session.refundPolicy] ?? detail.session.refundPolicy}</Badge>
            </div>
            {detail.meetLink ? (
              <div className="row">
                <a className="btn btn--sm" href={detail.meetLink} target="_blank" rel="noopener noreferrer">
                  <IconVideo size={16} /> Open Meet
                </a>
                <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(detail.meetLink!).then(() => toast("Link copied."))}>
                  <IconCopy size={16} /> Copy link
                </Button>
              </div>
            ) : (
              live && <p className="subtle">The Meet link has not been created yet.</p>
            )}
          </section>

          <section className="stack stack--sm" aria-labelledby="drawer-customer">
            <h3 id="drawer-customer" className="eyebrow">Customer</h3>
            {detail.redacted ? (
              <p className="muted text-sm">This customer&rsquo;s details were erased on request.</p>
            ) : (
              <dl className="summary">
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${detail.customerEmail}`}>{detail.customerEmail}</a>
                </dd>
                <dt>WhatsApp</dt>
                <dd className="tabular">
                  {formatIndianMobile(detail.whatsapp)} {detail.whatsappOptIn ? "" : "(not opted in)"}
                </dd>
                <dt>Booked</dt>
                <dd>{dateTime(detail.createdAt)}</dd>
              </dl>
            )}
          </section>

          {!detail.redacted && detail.intakeAnswers.length > 0 && (
            <section className="stack stack--sm" aria-labelledby="drawer-answers">
              <h3 id="drawer-answers" className="eyebrow">Customer&rsquo;s answers</h3>
              <dl className="stack stack--sm" style={{ margin: 0 }}>
                {detail.intakeAnswers.map((a) => (
                  <div key={a.id}>
                    <dt className="subtle">{a.label}</dt>
                    <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>{a.answer}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="stack stack--sm" aria-labelledby="drawer-payment">
            <h3 id="drawer-payment" className="eyebrow">Payment</h3>
            {detail.payments.length === 0 ? (
              <p className="muted text-sm">No payment yet.</p>
            ) : (
              detail.payments.map((p) => (
                <dl key={p.id} className="summary">
                  <dt>Amount</dt>
                  <dd className="money">{money(p.amountMinor, p.currency)}</dd>
                  <dt>Status</dt>
                  <dd>
                    <StatusPill kind="payment" status={p.status} />
                    {p.refundStatus && <span className="subtle"> · Refund: {p.refundStatus === "requested" ? "awaiting Razorpay" : p.refundStatus}</span>}
                  </dd>
                  {p.refundAmountMinor !== null && (
                    <>
                      <dt>Refunded</dt>
                      <dd className="money">{money(p.refundAmountMinor, p.currency)}</dd>
                    </>
                  )}
                  {p.providerPaymentId && (
                    <>
                      <dt>Reference</dt>
                      <dd className="tabular">{p.providerPaymentId}</dd>
                    </>
                  )}
                  {p.failureReason && (
                    <>
                      <dt>Note</dt>
                      <dd>{p.failureReason}</dd>
                    </>
                  )}
                </dl>
              ))
            )}
          </section>

          <section className="stack stack--sm" aria-labelledby="drawer-messages">
            <h3 id="drawer-messages" className="eyebrow">Messages</h3>
            {detail.messages.filter((m) => m.channel !== "LOG").length === 0 ? (
              <p className="muted text-sm">Nothing sent yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Message</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.messages
                      .filter((m) => m.channel !== "LOG")
                      .map((m) => (
                        <tr key={m.id}>
                          <td>
                            {TEMPLATE[m.template] ?? m.template}
                            <div className="subtle">{dateTime(m.at)}</div>
                            {isUnconfirmedMessage(m) ? <div className="subtle break">{UNCONFIRMED_MESSAGE_TEXT}</div> : m.error && <div className="error-text break">{m.error}</div>}
                          </td>
                          <td>{CHANNEL[m.channel] ?? m.channel}</td>
                          <td>
                            {isUnconfirmedMessage(m) ? <Badge tone="warning">Not confirmed</Badge> : <StatusPill kind="message" status={m.status} />}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      <Dialog
        open={payLink !== null}
        onClose={() => setPayLink(null)}
        title="Send the payment link yourself"
        description="The customer was not e-mailed: this site sends no e-mail, and Gmail is not connected. Send them this link, for example on WhatsApp. It is the only copy shown."
        footer={<Button variant="primary" onClick={() => setPayLink(null)}>Done</Button>}
      >
        {payLink && <CopyField value={payLink} label="Copy link" />}
      </Dialog>

      {detail && (
        <>
          <ConfirmDialog
            open={dialog === "decline"}
            onClose={() => setDialog(null)}
            danger
            busy={busy === "decline"}
            title="Decline this request?"
            description={`${detail.customerName} is emailed that the request was not accepted. They have not been charged.`}
            confirmLabel="Decline request"
            onConfirm={() => run("decline", `/api/dashboard/bookings/${detail.id}/decision`, { action: "decline", reason: reason || undefined }, "Request declined.")}
          >
            <Field id="decline-reason" label="Note to the customer" optional help="Shown in the email, for example another time that suits you.">
              <Textarea id="decline-reason" value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} maxLength={300} />
            </Field>
          </ConfirmDialog>
          <ConfirmDialog
            open={dialog === "cancel"}
            onClose={() => setDialog(null)}
            danger
            busy={busy === "cancel"}
            title="Cancel this booking?"
            description={`${detail.customerName} will be told, the calendar event updated, and a captured payment flagged for a full refund.`}
            confirmLabel="Cancel booking"
            onConfirm={() => run("cancel", `/api/dashboard/bookings/${detail.id}`, { action: "cancel", reason: reason || undefined }, "Booking cancelled.")}
          >
            <Field id="cancel-reason" label="Reason" optional help="Kept for your records.">
              <Textarea id="cancel-reason" value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} maxLength={500} />
            </Field>
          </ConfirmDialog>
          {captured && (
            <ConfirmDialog
              open={dialog === "refund"}
              onClose={() => setDialog(null)}
              danger
              busy={busy === "refund"}
              title="Refund this payment?"
              description="The money goes back to the customer's original payment method through Razorpay. This cannot be undone."
              confirmLabel="Issue refund"
              onConfirm={() => {
                const minor = Math.round(Number(refundAmount) * 100);
                if (!Number.isFinite(minor) || minor <= 0 || minor > refundable) {
                  toast("Enter an amount up to what is left to refund.", "error");
                  return;
                }
                void run(
                  "refund",
                  `/api/dashboard/bookings/${detail.id}/refund`,
                  { amountMinor: minor === refundable ? undefined : minor },
                  "Refund issued.",
                );
              }}
            >
              <Field
                id="refund-amount"
                label={`Amount (${captured.currency})`}
                help={`Paid ${money(captured.amountMinor, captured.currency)}${captured.refundAmountMinor ? `, already refunded ${money(captured.refundAmountMinor, captured.currency)}` : ""}. Partial refunds are allowed.`}
              >
                <Input id="refund-amount" inputMode="decimal" value={refundAmount} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRefundAmount(e.target.value)} />
              </Field>
            </ConfirmDialog>
          )}
          <RescheduleDialog
            open={dialog === "reschedule"}
            onClose={() => setDialog(null)}
            serviceId={detail.session.serviceId}
            group={detail.session.serviceType === "GROUP"}
            busy={busy === "reschedule"}
            onConfirm={(start) => run("reschedule", `/api/dashboard/bookings/${detail.id}`, { action: "reschedule", startTime: start }, "Booking moved. The customer was told.")}
          />
        </>
      )}
    </Drawer>
  );
}

function RescheduleDialog({
  open,
  onClose,
  serviceId,
  group,
  busy,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  group: boolean;
  busy: boolean;
  onConfirm: (startIso: string) => void;
}) {
  const today = useMemo(() => todayIst(), []);
  const [month, setMonth] = useState(() => monthOf(today));
  const [days, setDays] = useState<Set<string> | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slot, setSlot] = useState<SlotOption | null>(null);

  useEffect(() => {
    if (!open) return;
    const first = ymd(month.y, month.m, 1);
    const from = first < today ? today : first;
    const to = ymd(month.y, month.m, daysInMonth(month.y, month.m));
    fetch(`/api/slots/days?${new URLSearchParams({ serviceId, from, to })}`)
      .then((r) => r.json())
      .then((b) => setDays(new Set<string>(b.days ?? [])))
      .catch(() => setDays(null));
  }, [open, serviceId, month, today]);

  useEffect(() => {
    if (!date) return;
    setSlots(null);
    setSlot(null);
    fetch(`/api/slots?${new URLSearchParams({ serviceId, date })}`)
      .then((r) => r.json())
      .then((b) => setSlots(b.slots ?? []))
      .catch(() => setSlots([]));
  }, [serviceId, date]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move to a new time"
      description={group ? "This moves the whole group session. Every attendee is told and their invite updated." : "The customer is told and their calendar invite updated."}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!slot} loading={busy} onClick={() => slot && onConfirm(slot.start)}>
            Move booking
          </Button>
        </>
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
        <p className="subtle">Only open times from your availability are shown. {APP_TIME_ZONE_NOTE}</p>
      </div>
    </Dialog>
  );
}
