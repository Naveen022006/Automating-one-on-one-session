"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconPencil, IconPlus, IconUsers, IconVideo } from "@/components/icons";
import { Drawer, Switch, useToast } from "@/components/ui/overlays";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Textarea, describedBy } from "@/components/ui/primitives";
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
}

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
};

function money(minor: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
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
