import { useState } from "react";
import * as Icons from "@web/components/icons";
import { Wordmark } from "@web/components/site/SiteChrome";
import { ConfirmDialog, CopyField, Dialog, Drawer, Menu, Switch, Tabs, ToastProvider, useToast } from "@web/components/ui/overlays";
import {
  Alert,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Pagination,
  Radio,
  Select,
  Skeleton,
  Stat,
  StatusPill,
  Stepper,
  Textarea,
  Tooltip,
  describedBy,
} from "@web/components/ui/primitives";
import { Calendar, TimeSlotPicker, monthOf, todayIn } from "@web/components/ui/scheduling";

function Swatch({ name }: { name: string }) {
  return (
    <div className="stack stack--sm" style={{ width: 120 }}>
      <div style={{ height: 48, borderRadius: 8, background: `var(${name})`, border: "1px solid var(--border)" }} />
      <code className="text-xs">{name}</code>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="stack" style={{ paddingTop: 24, borderTop: "1px solid var(--border)" }}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function Showcase() {
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sw, setSw] = useState(true);
  const [tab, setTab] = useState("one");
  const today = todayIn("UTC");
  const [month, setMonth] = useState(monthOf(today));
  const [day, setDay] = useState<string | null>(today);
  const [slot, setSlot] = useState<string | null>(null);
  const base = new Date(`${today}T04:30:00Z`).getTime();
  const slots = [0, 1, 2, 5, 6, 10, 11].map((i) => ({
    start: new Date(base + i * 30 * 60_000).toISOString(),
    end: new Date(base + (i + 1) * 30 * 60_000).toISOString(),
    seatsLeft: 5 - (i % 4),
  }));

  return (
    <main id="main" className="container" style={{ padding: "32px 20px 96px" }}>
      <div className="stack stack--lg">
        <div className="row row--between">
          <Wordmark />
          <Badge tone="warning">Development only</Badge>
        </div>
        <h1 className="display" style={{ fontSize: "var(--text-3xl)" }}>Design system</h1>
        <p className="muted prose">Every component and state, built from the tokens in app/styles/tokens.css.</p>

        <Section title="Colour">
          <div className="row" style={{ alignItems: "flex-start" }}>
            {["--ink", "--accent", "--accent-soft", "--bg", "--surface", "--surface-muted", "--border", "--border-strong", "--text-muted", "--success", "--warning", "--danger", "--info"].map((n) => (
              <Swatch key={n} name={n} />
            ))}
          </div>
        </Section>

        <Section title="Type">
          <p className="display" style={{ fontSize: "var(--text-4xl)" }}>Newsreader display</p>
          <p style={{ fontSize: "var(--text-2xl)", fontWeight: 600 }}>Inter 2xl semibold</p>
          <p>Body text at 16px with a comfortable line height for reading longer explanations.</p>
          <p className="muted">Muted supporting text.</p>
          <p className="subtle">Subtle small text.</p>
          <p className="money" style={{ fontSize: "var(--text-xl)" }}>₹1,23,456.00 · 10:30 · 11:00</p>
        </Section>

        <Section title="Buttons">
          <div className="row">
            <Button variant="primary">Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="ink">Ink</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="danger-solid">Danger solid</Button>
            <Button variant="primary" loading>Loading</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
            <Button size="lg" variant="primary">Large</Button>
            <Button className="btn--icon" variant="ghost" aria-label="Settings"><Icons.IconSettings /></Button>
          </div>
        </Section>

        <Section title="Form controls">
          <div className="form-grid form-grid--2">
            <Field id="d-input" label="Input" help="Help text explains the field.">
              <Input {...describedBy("d-input", { help: true })} placeholder="Placeholder" />
            </Field>
            <Field id="d-error" label="With error" error="This field is required.">
              <Input {...describedBy("d-error", { error: true })} defaultValue="Wrong" />
            </Field>
            <Field id="d-select" label="Select">
              <Select id="d-select" defaultValue="b">
                <option value="a">Option A</option>
                <option value="b">Option B</option>
              </Select>
            </Field>
            <Field id="d-disabled" label="Disabled" optional>
              <Input id="d-disabled" disabled defaultValue="Not editable" />
            </Field>
            <Field id="d-textarea" label="Textarea">
              <Textarea id="d-textarea" defaultValue="Multi-line text" />
            </Field>
            <div className="stack stack--sm">
              <Checkbox label="Checkbox" defaultChecked />
              <Checkbox label="Disabled checkbox" disabled />
              <Radio name="r" label="Radio one" defaultChecked />
              <Radio name="r" label="Radio two" />
              <Switch checked={sw} onChange={setSw} label={`Switch ${sw ? "on" : "off"}`} />
            </div>
          </div>
        </Section>

        <Section title="Status">
          <div className="row">
            {["HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "EXPIRED", "CANCELLED", "FAILED"].map((s) => (
              <StatusPill key={s} kind="booking" status={s} />
            ))}
          </div>
          <div className="row">
            {["PENDING", "SENT", "DELIVERED", "READ", "FAILED"].map((s) => (
              <StatusPill key={s} kind="message" status={s} />
            ))}
            {["CREATED", "CAPTURED", "REFUNDED"].map((s) => (
              <StatusPill key={s} kind="payment" status={s} />
            ))}
            <Badge tone="accent" plain>Plain badge</Badge>
          </div>
          <div className="stack">
            <Alert tone="info" title="Info">Something worth knowing.</Alert>
            <Alert tone="success" title="Success">It worked.</Alert>
            <Alert tone="warning" title="Warning">Check this before continuing.</Alert>
            <Alert tone="danger" title="Error" action={<Button size="sm">Retry</Button>}>It did not work.</Alert>
          </div>
        </Section>

        <Section title="Cards, stats, avatars">
          <div className="grid grid--3">
            <Card title="Card title" actions={<Button size="sm">Action</Button>}>Card body content.</Card>
            <Card><Stat label="Earned this month" value="₹24,950" hint="12 payments" /></Card>
            <Card>
              <div className="row">
                <Avatar name="Demo Creator" size="sm" />
                <Avatar name="Demo Creator" />
                <Avatar name="Demo Creator" size="lg" />
              </div>
            </Card>
          </div>
          <CopyField value="https://example.com/demo" />
        </Section>

        <Section title="Table, tabs, breadcrumb, pagination, stepper">
          <Breadcrumb items={[{ label: "Dashboard", href: "/dashboard" }, { label: "Sessions", href: "/dashboard/sessions" }, { label: "Booking" }]} />
          <Tabs label="Example" value={tab} onChange={setTab} tabs={[{ value: "one", label: "Upcoming", count: 4 }, { value: "two", label: "Past" }, { value: "three", label: "Cancelled" }]} />
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Customer</th><th>Status</th><th className="num">Amount</th></tr></thead>
              <tbody>
                <tr data-clickable><td>Ananya R.</td><td><StatusPill kind="booking" status="SCHEDULED" /></td><td className="num">₹499.00</td></tr>
                <tr data-clickable><td>Rahul M.</td><td><StatusPill kind="booking" status="PAID" /></td><td className="num">₹499.00</td></tr>
              </tbody>
            </table>
          </div>
          <Pagination page={2} pageCount={5} hrefFor={(p) => `/design?page=${p}`} />
          <Stepper steps={["Service", "Date & time", "Details", "Pay", "Confirmation"]} current={2} />
        </Section>

        <Section title="Date and time pickers">
          <div className="picker">
            <Calendar month={month} onMonthChange={setMonth} value={day} onChange={setDay} availableDays={null} minDay={today} />
            <TimeSlotPicker slots={slots} value={slot} onChange={(s) => setSlot(s.start)} tz="Asia/Kolkata" showSeats />
          </div>
          <TimeSlotPicker slots={null} value={null} onChange={() => {}} tz="UTC" />
        </Section>

        <Section title="Overlays and feedback">
          <div className="row">
            <Button onClick={() => setDialog(true)}>Dialog</Button>
            <Button variant="danger" onClick={() => setConfirm(true)}>Confirm dialog</Button>
            <Button onClick={() => setDrawer(true)}>Drawer</Button>
            <Button onClick={() => toast("Saved.")}>Toast</Button>
            <Button onClick={() => toast("Something failed.", "error")}>Error toast</Button>
            <Menu label="More" trigger={<Icons.IconMore />} items={[{ label: "Edit", onSelect: () => toast("Edit") }, "separator", { label: "Delete", danger: true, onSelect: () => toast("Delete") }]} />
            <Tooltip content="Tooltip text"><Button variant="ghost">Hover me</Button></Tooltip>
          </div>
          <Dialog open={dialog} onClose={() => setDialog(false)} title="Dialog title" description="Supporting description." footer={<Button variant="primary" onClick={() => setDialog(false)}>Done</Button>}>
            Dialog body.
          </Dialog>
          <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => setConfirm(false)} danger title="Delete this?" description="This cannot be undone." confirmLabel="Delete" />
          <Drawer open={drawer} onClose={() => setDrawer(false)} title="Drawer title" subtitle="Subtitle">
            Drawer content.
          </Drawer>
          <div className="grid grid--2">
            <EmptyState icon={<Icons.IconCalendar />} title="Empty state" action={<Button variant="primary">Do the next thing</Button>}>
              Explains what to do next.
            </EmptyState>
            <div className="stack">
              <Skeleton height={20} width="40%" />
              <Skeleton height={60} />
              <Skeleton height={60} />
            </div>
          </div>
        </Section>

        <Section title="Icons">
          <div className="row">
            {Object.entries(Icons).map(([name, Icon]) => (
              <span key={name} title={name} className="tooltip">
                <Icon size={22} />
              </span>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}

export function DesignShowcase() {
  return (
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  );
}
