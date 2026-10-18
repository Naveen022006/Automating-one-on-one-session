import { AppLink } from "@web/lib/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertCircle,
  IconCalendar,
  IconCheckCircle,
  IconChevronLeft,
  IconClock,
  IconDownload,
  IconGlobe,
  IconUsers,
  IconVideo,
} from "@web/components/icons";
import {
  Calendar,
  TimeSlotPicker,
  monthOf,
  todayIst,
  addMonths,
  daysInMonth,
  ymd,
  type SlotOption,
} from "@web/components/ui/scheduling";
import { focusFirstInvalid, headingToFocus } from "@web/components/ui/focus";
import { checkoutRefusalOutcome } from "@web/lib/checkout-refusal";
import { Alert, Avatar, Button, Card, Checkbox, Field, Input, Select, Stepper, Textarea, describedBy } from "@web/components/ui/primitives";
import { formatMoney } from "@/lib/format";
import {
  APP_CALLING_CODE,
  APP_TIME_ZONE_NOTE,
  INDIAN_MOBILE_ERROR,
  INDIAN_MOBILE_PATTERN,
  formatDateTime,
  formatDay,
  formatDuration,
  indianMobileDigits,
  parseIndianMobile,
} from "@/lib/india";
import type { IntakeQuestion } from "@/lib/intake";

interface ServiceView {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
  refundText: string;
  intakeQuestions: IntakeQuestion[];
  prepNotes: string | null;
  requiresApproval: boolean;
}
interface Host {
  name: string;
  photoUrl: string | null;
  slug: string;
}
interface HoldResult {
  bookingId: string;
  holdExpiresAt: string;
  pollToken?: string | null;
}
interface CheckoutResult {
  bookingId: string;
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  holdExpiresAt: string;
  customer: { name: string; email: string; contact: string };
}
interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: { error: { description: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const STEPS = ["Service", "Date & time", "Details", "Pay", "Confirmation"];
type Step = 0 | 1 | 2 | 3 | 4;

function loadRazorpay(): Promise<boolean> {
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = "https://checkout.razorpay.com/v1/checkout.js";
    el.onload = () => resolve(true);
    el.onerror = () => resolve(false);
    document.body.appendChild(el);
  });
}

// Money, durations and times come from lib/india.ts through lib/format.ts: rupees with Indian grouping, and every time in IST.
const money = formatMoney;
const duration = formatDuration;
function when(iso: string) {
  return formatDateTime(new Date(iso));
}

export function BookingFlow({
  host,
  services,
  initialServiceId,
  preview,
}: {
  host: Host;
  services: ServiceView[];
  initialServiceId: string | null;
  preview: boolean;
}) {
  const initial = services.find((s) => s.id === initialServiceId) ?? (services.length === 1 ? services[0] : null);
  const [service, setService] = useState<ServiceView | null>(initial);
  const [step, setStep] = useState<Step>(initial ? 1 : 0);
  const today = useMemo(() => todayIst(), []);
  const [month, setMonth] = useState(() => monthOf(todayIst()));
  const [days, setDays] = useState<Set<string> | null>(null);
  const [daysLoading, setDaysLoading] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slot, setSlot] = useState<SlotOption | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Set when the service needs the host's approval: the request was sent and nothing is payable yet.
  const [requested, setRequested] = useState<{ decideWithinHours: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState<HoldResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [payState, setPayState] = useState<"idle" | "confirming" | "confirmed" | "failed">("idle");
  const [meetLink, setMeetLink] = useState<string | null>(null);
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [resend, setResend] = useState<"idle" | "busy" | "sent" | "error">("idle");

  // Days with open slots for the visible month.
  useEffect(() => {
    if (!service || step !== 1) return;
    let cancelled = false;
    const first = ymd(month.y, month.m, 1);
    const from = first < today ? today : first;
    const to = ymd(month.y, month.m, daysInMonth(month.y, month.m));
    if (to < from) {
      setDays(new Set());
      return;
    }
    setDaysLoading(true);
    fetch(`/api/slots/days?${new URLSearchParams({ serviceId: service.id, from, to })}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Could not load available days");
        if (!cancelled) setDays(new Set<string>(data.days));
      })
      .catch((e: Error) => !cancelled && (setDays(null), setError(e.message)))
      .finally(() => !cancelled && setDaysLoading(false));
    return () => {
      cancelled = true;
    };
  }, [service, month, today, step]);

  // Pick the first available day automatically so the customer sees times straight away.
  useEffect(() => {
    if (days && days.size > 0 && (!date || !days.has(date))) setDate([...days].sort()[0]);
    if (days && days.size === 0) setDate(null);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  // Times for the chosen day.
  useEffect(() => {
    if (!service || !date) {
      setSlots(null);
      return;
    }
    let cancelled = false;
    setSlots(null);
    setSlot(null);
    fetch(`/api/slots?${new URLSearchParams({ serviceId: service.id, date })}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Could not load times");
        if (!cancelled) setSlots(data.slots);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [service, date]);

  // After a step change, move focus to the new step's heading: the button that was pressed is gone, and without this the keyboard
  // focus falls back to the top of the document (and a screen reader reads nothing about the new step). Only when the step really
  // changed since the last one seen (web/src/components/ui/focus.ts): never on the page load, also not in StrictMode's second effect pass.
  const lastStep = useRef(step);
  useEffect(() => {
    const id = headingToFocus(lastStep.current, step, requested !== null);
    lastStep.current = step;
    if (id) document.getElementById(id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of step moves focus
  }, [step]);

  // A failed submit: focus the first field marked invalid. Bumped in the same batch as the errors, so this runs after they are in the DOM.
  const detailsForm = useRef<HTMLFormElement>(null);
  const [focusErrors, setFocusErrors] = useState(0);
  useEffect(() => {
    if (focusErrors > 0) focusFirstInvalid(detailsForm.current);
  }, [focusErrors]);

  // Hold countdown.
  useEffect(() => {
    if (!hold || step !== 3) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold, step]);

  // After checkout: wait for the server (webhook) to confirm, then keep polling briefly for the Meet link.
  useEffect(() => {
    if (!hold || (payState !== "confirming" && payState !== "confirmed")) return;
    if (payState === "confirmed" && meetLink) return;
    let stopped = false;
    const started = Date.now();
    const poll = async () => {
      try {
        const qs = hold.pollToken ? `?t=${encodeURIComponent(hold.pollToken)}` : "";
        const r = await fetch(`/api/bookings/${encodeURIComponent(hold.bookingId)}${qs}`);
        const data = await r.json();
        if (stopped) return;
        if (data.meetLink) setMeetLink(data.meetLink);
        if (data.manageUrl) setManageUrl(data.manageUrl);
        if (["PAID", "SCHEDULED", "COMPLETED"].includes(data.status)) {
          if (payState !== "confirmed") {
            setPayState("confirmed");
            setStep(4);
          }
          if (data.meetLink) return;
        } else if (data.status === "FAILED") {
          return setPayState("failed");
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > 150_000) {
        if (payState === "confirming") setPayState("failed");
        return;
      }
      setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [payState, hold, meetLink]);

  function chooseService(s: ServiceView) {
    setService(s);
    setSlot(null);
    setDate(null);
    setDays(null);
    setError(null);
    setStep(1);
  }

  async function submitDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!service || !slot) return;
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = "Enter your name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) local.email = "Enter a valid email address.";
    if (!indianMobileDigits(whatsapp)) local.whatsapp = `${INDIAN_MOBILE_ERROR}.`;
    if (!optIn) local.optIn = "Tick this so we can send your link and reminders on WhatsApp.";
    for (const q of service.intakeQuestions) {
      if (q.required && !(answers[q.id] ?? "").trim()) local[`q:${q.id}`] = "Please answer this question.";
    }
    setErrors(local);
    if (Object.keys(local).length) {
      // Put the keyboard (and a screen reader) on the first field that has an error once the texts are rendered (the effect below),
      // so a failed submit is never silent when the message is above the fold.
      setFocusErrors((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: service.id, startTime: slot.start, name, email, whatsapp: parseIndianMobile(whatsapp) ?? whatsapp, whatsappOptIn: optIn, answers }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          setError(`${data.error ?? "That time was just taken."} Please pick another time.`);
          setSlot(null);
          setDate((d) => d);
          setStep(1);
        } else {
          if (data.answerErrors) {
            setErrors(Object.fromEntries(Object.entries(data.answerErrors as Record<string, string>).map(([k, v]) => [`q:${k}`, v])));
            setFocusErrors((n) => n + 1);
          }
          setError(data.error ?? "Could not hold that time.");
        }
        return;
      }
      if (data.requiresApproval) {
        setRequested({ decideWithinHours: data.decideWithinHours ?? 48 });
        setStep(4);
        return;
      }
      setNow(Date.now());
      setHold(data);
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!hold || !service) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("The payment window could not load. Check your connection and try again.");
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The poll token proves this browser made the hold; the server refuses a checkout without it.
        body: JSON.stringify({ bookingId: hold.bookingId, token: hold.pollToken }),
      });
      const data = await res.json();
      if (res.status === 409) {
        // Refused because of the booking's state: find out which state, instead of leaving the countdown and the Pay button up.
        const outcome = await refusalOutcome(hold);
        if (outcome === "paid") {
          setBusy(false);
          return setPayState("confirming"); // the poll below confirms it and fetches the Meet link
        }
        if (outcome === "hold-ended") {
          setBusy(false);
          return setHold((h) => (h ? { ...h, holdExpiresAt: new Date(Date.now() - 5000).toISOString() } : h)); // shows "Your hold has ended"
        }
        if (outcome === "failed") {
          setBusy(false);
          return setPayState("failed");
        }
      }
      if (!res.ok) throw new Error(data.error ?? "Could not start payment");
      const c = data as CheckoutResult;
      setHold((h) => (h ? { ...h, holdExpiresAt: c.holdExpiresAt } : h));
      const rzp = new window.Razorpay({
        key: c.keyId,
        order_id: c.orderId,
        amount: c.amountMinor,
        currency: c.currency,
        name: host.name,
        description: service.title,
        prefill: c.customer,
        theme: { color: "#17694f" },
        // Only a hint: the booking becomes paid when the verified webhook says so.
        handler: () => setPayState("confirming"),
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.on("payment.failed", (r) => {
        setError(`${r.error.description} You can try again; your time is still held.`);
        setBusy(false);
      });
      rzp.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function refusalOutcome(h: HoldResult) {
    try {
      const qs = h.pollToken ? `?t=${encodeURIComponent(h.pollToken)}` : "";
      const r = await fetch(`/api/bookings/${encodeURIComponent(h.bookingId)}${qs}`);
      return checkoutRefusalOutcome(r.ok ? await r.json() : null, Date.now());
    } catch {
      return "unknown" as const;
    }
  }

  async function resendLink() {
    if (!hold) return;
    setResend("busy");
    const r = await fetch(`/api/bookings/${encodeURIComponent(hold.bookingId)}/resend${hold.pollToken ? `?t=${encodeURIComponent(hold.pollToken)}` : ""}`, { method: "POST" });
    setResend(r.ok ? "sent" : "error");
  }

  function startOver() {
    setHold(null);
    setRequested(null);
    setSlot(null);
    setPayState("idle");
    setError(null);
    setDays(null);
    setStep(1);
  }

  const msLeft = hold ? new Date(hold.holdExpiresAt).getTime() - now : 0;
  const expired = hold !== null && step === 3 && msLeft <= 0 && payState === "idle";
  const mm = Math.floor(Math.max(msLeft, 0) / 60000);
  const ss = Math.floor((Math.max(msLeft, 0) % 60000) / 1000);

  const summary = (
    <Card className="booking-summary" title={<h2 className="card__title">Your booking</h2>}>
      <div className="stack">
        <div className="row row--nowrap">
          <Avatar name={host.name} src={host.photoUrl} />
          <div>
            <p style={{ fontWeight: 600 }}>{host.name}</p>
            <p className="subtle">Host</p>
          </div>
        </div>
        {service ? (
          <dl className="summary">
            <dt>Session</dt>
            <dd>{service.title}</dd>
            <dt>Length</dt>
            <dd>{duration(service.durationMin)}</dd>
            <dt>Where</dt>
            <dd>Google Meet</dd>
            {slot && (
              <>
                <dt>When</dt>
                <dd>{when(slot.start)}</dd>
              </>
            )}
            <dt>Price</dt>
            <dd className="money">{money(service.priceMinor, service.currency)}</dd>
          </dl>
        ) : (
          <p className="muted text-sm">Choose a session to see the details.</p>
        )}
        {service && <p className="subtle">{service.refundText}</p>}
      </div>
    </Card>
  );

  return (
    <div className="stack stack--lg">
      <div className="stack stack--sm">
        <h1 className="display" style={{ fontSize: "var(--text-2xl)" }}>
          Book a session with {host.name}
        </h1>
        <Stepper steps={STEPS} current={step} />
      </div>

      <div className="booking-layout">
        <div className="stack">
          {error && step < 4 && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}

          {step === 0 && (
            <section aria-labelledby="pick-service" className="stack">
              <h2 id="pick-service" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                Choose a session
              </h2>
              {services.length === 0 && <p className="muted">There are no sessions to book right now.</p>}
              {services.map((s) => (
                <button key={s.id} type="button" className="option" aria-pressed={service?.id === s.id} onClick={() => chooseService(s)}>
                  <span style={{ color: "var(--accent)", marginTop: 2 }}>{s.type === "GROUP" ? <IconUsers /> : <IconVideo />}</span>
                  <span className="stack stack--sm" style={{ flex: 1 }}>
                    <span className="option__title">{s.title}</span>
                    <span className="option__meta">
                      {duration(s.durationMin)} · {s.type === "GROUP" ? `Group, up to ${s.capacity}` : "1:1"}
                    </span>
                    {s.requiresApproval && <span className="option__meta">Needs {host.name}&rsquo;s approval before you pay</span>}
                    {s.description && <span className="option__meta">{s.description}</span>}
                  </span>
                  <span className="option__price">{money(s.priceMinor, s.currency)}</span>
                </button>
              ))}
            </section>
          )}

          {step === 1 && service && (
            <section aria-labelledby="pick-time" className="stack">
              <div className="row row--between">
                <h2 id="pick-time" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                  Pick a date and time
                </h2>
                {services.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                    <IconChevronLeft size={16} /> Change session
                  </Button>
                )}
              </div>
              <Card>
                <div className="picker">
                  <Calendar
                    month={month}
                    onMonthChange={(m) => {
                      setMonth(m);
                      setDays(null);
                    }}
                    value={date}
                    onChange={setDate}
                    availableDays={days}
                    loading={daysLoading}
                    minDay={today}
                    maxMonth={addMonths(monthOf(today).y, monthOf(today).m, 6)}
                  />
                  <div className="stack">
                    <div className="row row--between">
                      <p style={{ fontWeight: 600 }}>
                        {date
                          ? formatDay(date)
                          : daysLoading
                            ? "Finding open days…"
                            : days && days.size === 0
                              ? "No open days this month"
                              : "Choose a day"}
                      </p>
                    </div>
                    {date ? (
                      <TimeSlotPicker slots={slots} value={slot?.start ?? null} onChange={setSlot} showSeats={service.type === "GROUP"} />
                    ) : (
                      days &&
                      days.size === 0 &&
                      !daysLoading && (
                        <Button
                          onClick={() => {
                            setMonth(addMonths(month.y, month.m, 1));
                            setDays(null);
                          }}
                        >
                          Look at next month
                        </Button>
                      )
                    )}
                    <p className="subtle row" style={{ gap: 6 }}>
                      <IconGlobe size={16} aria-hidden="true" /> {APP_TIME_ZONE_NOTE}
                    </p>
                  </div>
                </div>
              </Card>
              <div className="form-actions">
                <Button variant="primary" size="lg" disabled={!slot} onClick={() => setStep(2)}>
                  Continue
                </Button>
              </div>
            </section>
          )}

          {step === 2 && service && slot && (
            <section aria-labelledby="your-details">
              <form ref={detailsForm} className="stack" onSubmit={submitDetails} noValidate>
                <div className="row row--between">
                  <h2 id="your-details" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                    Your details
                  </h2>
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                    <IconChevronLeft size={16} /> Change time
                  </Button>
                </div>
                <Card>
                  <div className="form-grid">
                    <Field id="name" label="Full name" error={errors.name}>
                      <Input {...describedBy("name", { error: errors.name })} autoComplete="name" value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} required />
                    </Field>
                    <Field id="email" label="Email" error={errors.email} help="Your confirmation, receipt and calendar invite go here.">
                      <Input {...describedBy("email", { error: errors.email, help: true })} type="email" autoComplete="email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required />
                    </Field>
                    <Field id="wa" label="WhatsApp number" error={errors.whatsapp} help="Your 10-digit Indian mobile number, for example 98765 43210.">
                      <div className="input-group">
                        <span className="input-group__addon" aria-hidden="true">
                          {APP_CALLING_CODE}
                        </span>
                        <Input
                          {...describedBy("wa", { error: errors.whatsapp, help: true })}
                          type="tel"
                          autoComplete="tel-national"
                          inputMode="tel"
                          pattern={INDIAN_MOBILE_PATTERN}
                          maxLength={20}
                          placeholder="98765 43210"
                          value={whatsapp}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            const v = e.target.value;
                            // A pasted +91, 0 or 91 form is reduced to the ten digits the field shows.
                            setWhatsapp(indianMobileDigits(v) ?? v);
                          }}
                          required
                        />
                      </div>
                    </Field>
                    <div>
                      <Checkbox
                        checked={optIn}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOptIn(e.target.checked)}
                        aria-invalid={errors.optIn ? true : undefined}
                        aria-describedby={errors.optIn ? "optin-error" : undefined}
                        label="Send my meeting link and reminders on WhatsApp (SMS if WhatsApp fails)."
                      />
                      {errors.optIn && (
                        <p className="field__error" id="optin-error" role="alert">
                          <IconAlertCircle size={16} />
                          {errors.optIn}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
                {service.intakeQuestions.length > 0 && (
                  <Card title="A few questions from your host">
                    <div className="form-grid">
                      {service.intakeQuestions.map((q) => {
                        const id = `q-${q.id}`;
                        const err = errors[`q:${q.id}`];
                        const value = answers[q.id] ?? "";
                        const set = (v: string) => setAnswers((a) => ({ ...a, [q.id]: v }));
                        return (
                          <Field key={q.id} id={id} label={q.label} optional={!q.required} error={err}>
                            {q.type === "longtext" ? (
                              <Textarea {...describedBy(id, { error: err })} value={value} maxLength={1000} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => set(e.target.value)} />
                            ) : q.type === "select" ? (
                              <Select {...describedBy(id, { error: err })} value={value} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => set(e.target.value)}>
                                <option value="">Choose one</option>
                                {q.options?.map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </Select>
                            ) : (
                              <Input {...describedBy(id, { error: err })} value={value} maxLength={1000} onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value)} />
                            )}
                          </Field>
                        );
                      })}
                    </div>
                  </Card>
                )}
                {service.prepNotes && (
                  <Alert tone="info" title="Before your session">
                    {service.prepNotes}
                  </Alert>
                )}
                {preview && <Alert tone="info">Holding is disabled in preview.</Alert>}
                <div className="form-actions">
                  <Button type="submit" variant="primary" size="lg" loading={busy} disabled={preview}>
                    {service.requiresApproval ? "Send request" : "Hold this time"}
                  </Button>
                </div>
                <p className="subtle">
                  {service.requiresApproval
                    ? `${host.name} approves each booking. Your time is held while they review it, and you only pay if they approve. Nothing is charged now.`
                    : "We hold the time for 10 minutes while you pay. Nothing is charged yet."}
                </p>
              </form>
            </section>
          )}

          {step === 3 && service && slot && hold && (
            <section aria-labelledby="pay-title" className="stack">
              <h2 id="pay-title" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                {expired ? "Your hold has ended" : payState === "confirming" ? "Confirming your payment" : "Pay to confirm"}
              </h2>
              <Card>
                <div className="stack">
                  {expired ? (
                    <>
                      <p className="muted">
                        We held {when(slot.start)} for you, but the time ran out before payment. No money was taken.
                      </p>
                      <Button variant="primary" size="lg" onClick={startOver}>
                        Pick a time again
                      </Button>
                    </>
                  ) : payState === "confirming" ? (
                    <div className="stack" aria-live="polite">
                      <p className="row">
                        <span className="btn__spinner" aria-hidden="true" /> Waiting for Razorpay to confirm. This usually takes a few seconds.
                      </p>
                      <p className="subtle">Please keep this page open.</p>
                    </div>
                  ) : payState === "failed" ? (
                    <Alert tone="danger" title="We could not confirm your payment">
                      If money left your account it will be refunded automatically. Contact support with your booking reference{" "}
                      <span className="tabular">{hold.bookingId}</span>.
                    </Alert>
                  ) : (
                    <>
                      <div className="countdown" role="timer" aria-live="off">
                        <IconClock size={16} />
                        Held for you for <strong>{mm}:{String(ss).padStart(2, "0")}</strong>
                      </div>
                      <Button variant="primary" size="lg" block onClick={pay} loading={busy}>
                        Pay {money(service.priceMinor, service.currency)}
                      </Button>
                      <p className="subtle">
                        Secure payment by Razorpay: cards, UPI and netbanking. Booking reference <span className="tabular">{hold.bookingId}</span>
                      </p>
                    </>
                  )}
                </div>
              </Card>
            </section>
          )}

          {step === 4 && service && slot && requested && (
            <section aria-labelledby="requested-title" className="stack" aria-live="polite">
              <Alert tone="success" title="Request sent">
                {service.title} with {host.name}, {when(slot.start)}.
              </Alert>
              <Card>
                <div className="stack">
                  <h2 id="requested-title" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                    What happens next
                  </h2>
                  <ol className="stack stack--sm text-sm" style={{ paddingLeft: 20, margin: 0 }}>
                    <li>Your request has been sent to {host.name}. A copy goes to {email} when {host.name} has e-mail set up.</li>
                    <li>
                      {host.name} reviews it
                      {requested.decideWithinHours >= 48 ? " (usually within a couple of days)" : ""}. Your time is held until they answer.
                    </li>
                    <li>If they approve, you get a link to pay and confirm (by e-mail or from {host.name} directly). If not, you are not charged.</li>
                  </ol>
                  {service.prepNotes && (
                    <Alert tone="info" title="Before your session">
                      {service.prepNotes}
                    </Alert>
                  )}
                </div>
              </Card>
              <p className="subtle">
                <IconCheckCircle size={14} style={{ display: "inline", verticalAlign: "-2px" }} /> You can close this page.{" "}
                <AppLink href={`/${host.slug}`}>Back to {host.name}&rsquo;s page</AppLink>
              </p>
            </section>
          )}

          {step === 4 && service && slot && hold && (
            <section aria-labelledby="done-title" className="stack" aria-live="polite">
              <Alert tone="success" title="You're booked">
                {service.title} with {host.name}, {when(slot.start)}.
              </Alert>
              {service.prepNotes && (
                <Alert tone="info" title="Before your session">
                  {service.prepNotes}
                </Alert>
              )}
              <Card>
                <div className="stack">
                  <h2 id="done-title" tabIndex={-1} style={{ outline: "none" }} className="section-title">
                    What happens next
                  </h2>
                  {meetLink ? (
                    <div className="stack stack--sm">
                      <p className="muted text-sm">Your Google Meet link is ready. It was also sent to your WhatsApp and email.</p>
                      <a className="btn btn--primary btn--lg" href={meetLink} target="_blank" rel="noopener noreferrer">
                        <IconVideo /> Join Google Meet
                      </a>
                      <p className="subtle break">{meetLink}</p>
                    </div>
                  ) : (
                    <p className="row muted">
                      <span className="btn__spinner" aria-hidden="true" /> Creating your Google Meet link. It appears here in a moment and is sent to your WhatsApp and email.
                    </p>
                  )}
                  <ol className="stack stack--sm text-sm" style={{ paddingLeft: 20, margin: 0 }}>
                    <li>A calendar invite from Google arrives at {email}.</li>
                    <li>Reminders come 24 hours and 15 minutes before the session.</li>
                    <li>Need to change it? Use the link below or the one in your email.</li>
                  </ol>
                  <div className="row">
                    <a className="btn" href={`/api/bookings/${encodeURIComponent(hold.bookingId)}/ics${hold.pollToken ? `?t=${encodeURIComponent(hold.pollToken)}` : ""}`}>
                      <IconDownload size={16} /> Add to calendar (.ics)
                    </a>
                    {manageUrl && (
                      <a className="btn" href={manageUrl}>
                        <IconCalendar size={16} /> Reschedule or cancel
                      </a>
                    )}
                  </div>
                  <p className="text-sm muted">
                    Message not received?{" "}
                    {resend === "sent" ? (
                      <span role="status">We sent it again.</span>
                    ) : (
                      <button type="button" className="link-button" onClick={resendLink} disabled={resend === "busy"}>
                        Resend my link
                      </button>
                    )}
                    {resend === "error" && <span className="error-text"> Could not resend right now. Try again in a few minutes.</span>}
                  </p>
                  <p className="subtle">
                    Booking reference <span className="tabular">{hold.bookingId}</span>
                  </p>
                </div>
              </Card>
              <p className="subtle">
                <IconCheckCircle size={14} style={{ display: "inline", verticalAlign: "-2px" }} /> You can close this page.{" "}
                <AppLink href={`/${host.slug}`}>Back to {host.name}&rsquo;s page</AppLink>
              </p>
            </section>
          )}
        </div>
        {summary}
      </div>
    </div>
  );
}
