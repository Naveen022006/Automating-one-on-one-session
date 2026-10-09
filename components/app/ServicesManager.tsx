"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconPencil, IconPlus, IconTrash, IconUsers, IconVideo } from "@/components/icons";
import { Drawer, Switch, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, describedBy } from "@/components/ui/primitives";
import { MAX_QUESTIONS, type IntakeQuestion } from "@/lib/intake";
import { useApi } from "./ApiProvider";

export interface ServiceAdmin {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  priceMinor: number;
  currency: string;
  type: "ONE_TO_ONE" | "GROUP";
  capacity: number;
  active: boolean;
  refundPolicy: "FULL" | "NOTICE_24H" | "NONE";
  intakeQuestions: IntakeQuestion[];
  minNoticeHours: number;
  maxAdvanceDays: number;
  prepNotes: string | null;
  requiresApproval: boolean;
}

const NOTICE_OPTIONS = [
  { value: 0, label: "No minimum" },
  { value: 1, label: "1 hour" },
  { value: 2, label: "2 hours" },
  { value: 6, label: "6 hours" },
  { value: 12, label: "12 hours" },
  { value: 24, label: "1 day" },
  { value: 48, label: "2 days" },
  { value: 72, label: "3 days" },
  { value: 168, label: "1 week" },
];
const ADVANCE_OPTIONS = [7, 14, 30, 60, 90, 180, 365];
const QUESTION_TYPE_LABEL = { text: "Short answer", longtext: "Long answer", select: "Choose one" } as const;

const POLICIES = [
  { value: "FULL", label: "Flexible: full refund any time before the session" },
  { value: "NOTICE_24H", label: "24-hour notice: full refund if cancelled 24 h ahead" },
  { value: "NONE", label: "Non-refundable when the customer cancels" },
] as const;

const BLANK: Omit<ServiceAdmin, "id"> = {
  title: "",
  description: "",
  durationMin: 30,
  priceMinor: 49900,
  currency: "INR",
  type: "ONE_TO_ONE",
  capacity: 1,
  active: true,
  refundPolicy: "FULL",
  intakeQuestions: [],
  minNoticeHours: 0,
  maxAdvanceDays: 60,
  prepNotes: null,
  requiresApproval: false,
};

function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

interface DraftQuestion {
  id: string;
  label: string;
  type: IntakeQuestion["type"];
  required: boolean;
  /** One choice per line (select questions only). */
  options: string;
}

function toDraft(q: IntakeQuestion): DraftQuestion {
  return { id: q.id, label: q.label, type: q.type, required: q.required, options: (q.options ?? []).join("\n") };
}

export function ServicesManager({ services, compact, onSaved }: { services: ServiceAdmin[]; compact?: boolean; onSaved?: () => void }) {
  const [editing, setEditing] = useState<ServiceAdmin | (Omit<ServiceAdmin, "id"> & { id?: undefined }) | null>(null);
  const api = useApi();
  const toast = useToast();
  const router = useRouter();

  async function toggle(s: ServiceAdmin) {
    const r = await api("/api/dashboard/services", { method: "PATCH", body: { serviceId: s.id, active: !s.active } });
    if (!r.ok) return toast(r.data.error ?? "Could not update the service.", "error");
    toast(s.active ? "Hidden from your booking page." : "Visible on your booking page.");
    router.refresh();
    onSaved?.();
  }

  return (
    <div className="stack">
      {services.length === 0 ? (
        <EmptyState
          icon={<IconVideo />}
          title="Add your first service"
          action={
            <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>
              <IconPlus size={16} /> Add a service
            </Button>
          }
        >
          A service is what customers book: a 30-minute call, a group workshop. You set the length, price and seats.
        </EmptyState>
      ) : (
        <>
          <div className="stack">
            {services.map((s) => (
              <Card key={s.id}>
                <div className="row row--between" style={{ alignItems: "flex-start" }}>
                  <div className="row row--nowrap" style={{ alignItems: "flex-start", flex: "1 1 280px" }}>
                    <span style={{ color: "var(--accent)", marginTop: 2 }}>{s.type === "GROUP" ? <IconUsers /> : <IconVideo />}</span>
                    <div className="stack stack--sm">
                      <div className="row">
                        <h3 style={{ fontSize: "var(--text-base)" }}>{s.title}</h3>
                        {!s.active && <Badge>Hidden</Badge>}
                      </div>
                      <p className="muted text-sm">
                        {s.durationMin} min · {s.type === "GROUP" ? `Group, ${s.capacity} seats` : "1:1"} · <span className="money">{money(s.priceMinor, s.currency)}</span>
                      </p>
                      {(s.intakeQuestions.length > 0 || s.minNoticeHours > 0 || s.prepNotes || s.requiresApproval) && (
                        <p className="subtle">
                          {[
                            s.intakeQuestions.length > 0 ? `${s.intakeQuestions.length} question${s.intakeQuestions.length === 1 ? "" : "s"} for customers` : null,
                            s.minNoticeHours > 0 ? `${NOTICE_OPTIONS.find((o) => o.value === s.minNoticeHours)?.label ?? `${s.minNoticeHours} h`} notice` : null,
                            s.prepNotes ? "prep notes" : null,
                            s.requiresApproval ? "needs your approval" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      {s.type === "GROUP" && s.durationMin > 60 && (
                        <p className="text-sm" style={{ color: "var(--warning)" }}>Longer than the 60-minute group limit on free Gmail.</p>
                      )}
                    </div>
                  </div>
                  <div className="row">
                    <Switch checked={s.active} onChange={() => toggle(s)} label={s.active ? "Bookable" : "Hidden"} />
                    <Button size="sm" onClick={() => setEditing(s)}>
                      <IconPencil size={16} /> Edit
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          {!compact && (
            <div>
              <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>
                <IconPlus size={16} /> Add a service
              </Button>
            </div>
          )}
          {compact && (
            <div>
              <Button onClick={() => setEditing({ ...BLANK })}>
                <IconPlus size={16} /> Add another
              </Button>
            </div>
          )}
        </>
      )}
      {editing && (
        <ServiceForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
            onSaved?.();
          }}
        />
      )}
    </div>
  );
}

function ServiceForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: ServiceAdmin | (Omit<ServiceAdmin, "id"> & { id?: undefined });
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description ?? "");
  const [duration, setDuration] = useState(String(initial.durationMin));
  const [price, setPrice] = useState((initial.priceMinor / 100).toFixed(2));
  const [currency, setCurrency] = useState(initial.currency);
  const [type, setType] = useState(initial.type);
  const [capacity, setCapacity] = useState(String(initial.type === "GROUP" ? initial.capacity : 5));
  const [policy, setPolicy] = useState(initial.refundPolicy);
  const [questions, setQuestions] = useState<DraftQuestion[]>(() => initial.intakeQuestions.map(toDraft));
  const [minNotice, setMinNotice] = useState(String(initial.minNoticeHours));
  const [maxAdvance, setMaxAdvance] = useState(String(initial.maxAdvanceDays));
  const [prepNotes, setPrepNotes] = useState(initial.prepNotes ?? "");
  const [requiresApproval, setRequiresApproval] = useState(initial.requiresApproval);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const durationMin = Number(duration);
  const priceMinor = Math.round(Number(price) * 100);
  const seats = Number(capacity);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!title.trim()) local.title = "Give the service a name.";
    if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 480) local.duration = "Between 5 and 480 minutes.";
    if (!Number.isFinite(priceMinor) || priceMinor < 0) local.price = "Enter a price, for example 499.";
    if (type === "GROUP" && (!Number.isInteger(seats) || seats < 2 || seats > 1000)) local.capacity = "Between 2 and 1000 seats.";
    questions.forEach((q, i) => {
      if (q.label.trim().length < 3) local[`q${i}`] = "Write the question (at least 3 characters).";
      else if (q.type === "select" && q.options.split("\n").map((o) => o.trim()).filter(Boolean).length < 2) local[`q${i}`] = "Add at least two choices, one per line.";
    });
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setFormError(null);
    const body = {
      title: title.trim(),
      description: description.trim() || (initial.id ? null : undefined),
      durationMin,
      priceMinor,
      currency,
      type,
      capacity: type === "GROUP" ? seats : 1,
      refundPolicy: policy,
      intakeQuestions: questions.map((q) => ({
        ...(q.id ? { id: q.id } : {}),
        label: q.label.trim(),
        type: q.type,
        required: q.required,
        ...(q.type === "select" ? { options: q.options.split("\n").map((o) => o.trim()).filter(Boolean) } : {}),
      })),
      minNoticeHours: Number(minNotice),
      maxAdvanceDays: Number(maxAdvance),
      prepNotes: prepNotes.trim() || (initial.id ? null : undefined),
      requiresApproval,
    };
    const r = initial.id
      ? await api("/api/dashboard/services", { method: "PATCH", body: { serviceId: initial.id, ...body } })
      : await api("/api/dashboard/services", { method: "POST", body });
    setBusy(false);
    if (!r.ok) {
      setFormError(r.data.error ?? "Could not save the service.");
      return;
    }
    toast(r.data.warning ? `Saved. ${r.data.warning}` : "Service saved.");
    onSaved();
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={initial.id ? "Edit service" : "New service"}
      footer={
        <>
          <Button variant="primary" type="submit" form="service-form" loading={busy}>
            Save service
          </Button>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </>
      }
    >
      <form id="service-form" className="stack stack--lg" onSubmit={save} noValidate>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="form-grid">
          <Field id="svc-title" label="Name" error={errors.title}>
            <Input {...describedBy("svc-title", { error: errors.title })} value={title} maxLength={200} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)} placeholder="1:1 career call" />
          </Field>
          <Field id="svc-desc" label="Description" optional help="One or two sentences shown on your booking page.">
            <Textarea id="svc-desc" value={description} maxLength={2000} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)} />
          </Field>
          <div className="form-grid form-grid--2">
            <Field id="svc-duration" label="Length (minutes)" error={errors.duration}>
              <Input {...describedBy("svc-duration", { error: errors.duration })} inputMode="numeric" value={duration} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDuration(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <Field id="svc-price" label="Price" error={errors.price}>
              <div className="input-group">
                <Select aria-label="Currency" value={currency} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCurrency(e.target.value)} style={{ width: 96, borderRadius: "8px 0 0 8px" }}>
                  {["INR", "USD", "EUR", "GBP", "AED", "SGD"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
                <Input {...describedBy("svc-price", { error: errors.price })} inputMode="decimal" value={price} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrice(e.target.value)} />
              </div>
            </Field>
          </div>
          <fieldset className="stack stack--sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field__label" style={{ marginBottom: 8 }}>Format</legend>
            <div className="segmented" role="group" aria-label="Format">
              <button type="button" aria-pressed={type === "ONE_TO_ONE"} onClick={() => setType("ONE_TO_ONE")}>
                1:1
              </button>
              <button type="button" aria-pressed={type === "GROUP"} onClick={() => setType("GROUP")}>
                Group
              </button>
            </div>
          </fieldset>
          {type === "GROUP" && (
            <Field id="svc-capacity" label="Seats" error={errors.capacity} help="Seats are counted as people book, so a session never oversells.">
              <Input {...describedBy("svc-capacity", { error: errors.capacity, help: true })} inputMode="numeric" value={capacity} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCapacity(e.target.value.replace(/\D/g, ""))} />
            </Field>
          )}
          {type === "GROUP" && durationMin > 60 && (
            <Alert tone="warning" title="Check your Google account">
              Free Gmail accounts end group Meet calls after 60 minutes. Use Google Workspace, or keep group sessions to 60 minutes.
            </Alert>
          )}
          <Field id="svc-policy" label="When a customer cancels" help="If you cancel, the customer is always refunded in full.">
            <Select id="svc-policy" value={policy} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPolicy(e.target.value as ServiceAdmin["refundPolicy"])}>
              {POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field__label">Booking rules</legend>
          <div className="form-grid form-grid--2">
            <Field id="svc-notice" label="Earliest a customer can book" help="How far ahead of the session they must book.">
              <Select id="svc-notice" value={minNotice} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMinNotice(e.target.value)}>
                {NOTICE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="svc-advance" label="Furthest ahead" help="How far into the future sessions can be booked.">
              <Select id="svc-advance" value={maxAdvance} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMaxAdvance(e.target.value)}>
                {ADVANCE_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </fieldset>

        <div className="stack stack--sm">
          <Switch checked={requiresApproval} onChange={() => setRequiresApproval((v) => !v)} label="I approve each booking request" />
          <p className="subtle">
            Customers choose a time and send a request instead of paying. The time is held for up to 48 hours while you decide. Approve and
            they get a link to pay; decline and nothing is charged.
          </p>
        </div>

        <Field id="svc-prep" label="What to prepare" optional help="Shown before booking, on the confirmation page and in the confirmation email.">
          <Textarea id="svc-prep" value={prepNotes} maxLength={1000} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrepNotes(e.target.value)} placeholder="For example: have your CV open and a list of the roles you are applying for." />
        </Field>

        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field__label">Questions for your customer</legend>
          <p className="subtle">Asked when someone books. You see the answers on the booking in your dashboard.</p>
          {questions.map((q, i) => (
            <Card key={i}>
              <div className="stack stack--sm">
                <Field id={`q-label-${i}`} label={`Question ${i + 1}`} error={errors[`q${i}`]}>
                  <Input
                    {...describedBy(`q-label-${i}`, { error: errors[`q${i}`] })}
                    value={q.label}
                    maxLength={120}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    placeholder="What would you like to work on?"
                  />
                </Field>
                <div className="form-grid form-grid--2">
                  <Field id={`q-type-${i}`} label="Answer type">
                    <Select id={`q-type-${i}`} value={q.type} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, type: e.target.value as DraftQuestion["type"] } : x)))}>
                      {(Object.keys(QUESTION_TYPE_LABEL) as (keyof typeof QUESTION_TYPE_LABEL)[]).map((t) => (
                        <option key={t} value={t}>
                          {QUESTION_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div style={{ alignSelf: "end" }}>
                    <Switch checked={q.required} onChange={() => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, required: !x.required } : x)))} label={q.required ? "Required" : "Optional"} />
                  </div>
                </div>
                {q.type === "select" && (
                  <Field id={`q-options-${i}`} label="Choices" help="One per line.">
                    <Textarea id={`q-options-${i}`} value={q.options} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} />
                  </Field>
                )}
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>
                    <IconTrash size={16} /> Remove question
                  </Button>
                </div>
              </div>
            </Card>
          ))}
          {questions.length < MAX_QUESTIONS && (
            <div>
              <Button onClick={() => setQuestions((qs) => [...qs, { id: "", label: "", type: "text", required: false, options: "" }])}>
                <IconPlus size={16} /> Add a question
              </Button>
            </div>
          )}
        </fieldset>

        <section className="stack stack--sm" aria-label="Preview">
          <p className="eyebrow">Preview on your booking page</p>
          <div className="option" aria-hidden="true">
            <span style={{ color: "var(--accent)", marginTop: 2 }}>{type === "GROUP" ? <IconUsers /> : <IconVideo />}</span>
            <span className="stack stack--sm" style={{ flex: 1 }}>
              <span className="option__title">{title || "Service name"}</span>
              <span className="option__meta">
                {Number.isFinite(durationMin) && durationMin > 0 ? `${durationMin} min` : "Length"} · {type === "GROUP" ? `Group, up to ${seats || "?"}` : "1:1"}
              </span>
              {description && <span className="option__meta">{description}</span>}
            </span>
            <span className="option__price">{Number.isFinite(priceMinor) ? money(priceMinor, currency) : "-"}</span>
          </div>
        </section>
      </form>
    </Drawer>
  );
}
