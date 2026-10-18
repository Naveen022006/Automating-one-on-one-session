import { useState } from "react";
import { IconDownload, IconTrash } from "@web/components/icons";
import { FocusedLayout } from "@web/components/site/SiteChrome";
import { ConfirmDialog } from "@web/components/ui/overlays";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, cx, type Tone } from "@web/components/ui/primitives";
import { AppLink } from "@web/lib/link";
import type { Jsonify } from "@/lib/jsonify";
import type { CustomerPortalView as CustomerPortalViewData } from "@/lib/views/customer-portal";
import { ReceiptCard } from "./ReceiptCard";
import { formatDateTime, formatTime } from "@/lib/india";

type Ok = Extract<Jsonify<CustomerPortalViewData>, { state: "ok" }>;
type Booking = Ok["bookings"][number];

// Indian Standard Time throughout ("Mon, 12 Oct 2026, 11:00 AM IST"); the end of a session is its clock time.
const when = (iso: string) => formatDateTime(new Date(iso));
const clock = (iso: string) => formatTime(new Date(iso));

/** Sessions that have not finished: shown first. "In progress" has started but is not over, so an erasure keeps it. */
const isOpen = (b: Booking) => b.statusText === "Upcoming" || b.statusText === "In progress";

function tone(b: Booking): Tone {
  if (isOpen(b)) return "success";
  if (b.status === "CANCELLED") return "danger";
  if (b.statusText === "Completed") return "neutral";
  return "warning";
}

/** The manage link is an absolute URL built from APP_URL; the page only follows its path, and only if it is a manage link. */
function manageHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.pathname.startsWith("/manage/") ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

/**
 * The customer portal (`/bookings/:token`): every booking made with the e-mail address the link was sent to, across all hosts, with
 * the manage link of upcoming sessions, a printable receipt, a JSON download of the data held, and erasure. The token in the URL is the
 * only credential; `token` here is used to build the download link and to call the erase endpoint.
 * `onChanged` re-reads the list after an erasure that kept upcoming bookings.
 */
export function CustomerPortalView({ data, token, onChanged }: { data: Jsonify<CustomerPortalViewData>; token: string; onChanged?: () => void }) {
  const [openReceipt, setOpenReceipt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ erased: number; blocked: number } | null>(null);

  if (data.state !== "ok") {
    return (
      <FocusedLayout>
        <div className="stack stack--lg">
          <h1 className="focused__title">Your bookings</h1>
          <Alert tone="warning" title="This link has expired" action={<ButtonLink href="/bookings">Get a new link</ButtonLink>}>
            For your security, these links work for 60 minutes. Ask for a new one with the e-mail address you booked with.
          </Alert>
        </div>
      </FocusedLayout>
    );
  }

  async function erase() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customer/portal/${encodeURIComponent(token)}/erase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; erased?: number; blocked?: number; state?: string };
      if (!res.ok) {
        setConfirm(false);
        setError(res.status === 403 ? "This link has expired. Ask for a new one." : (body.error ?? "Could not erase your data. Please try again."));
        return;
      }
      const next = { erased: body.erased ?? 0, blocked: body.blocked ?? 0 };
      setResult(next);
      setConfirm(false);
      setOpenReceipt(null);
      if (next.blocked > 0) onChanged?.();
    } catch {
      setConfirm(false);
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Nothing is kept: the link was deleted with the data, so there is nothing more to show.
  if (result && result.blocked === 0) {
    return (
      <FocusedLayout>
        <div className="stack stack--lg">
          <h1 className="focused__title">Your data was erased</h1>
          <Alert tone="success" title="Done">
            We erased your name, e-mail address, phone number, time zone and booking answers from {result.erased} {result.erased === 1 ? "booking" : "bookings"}.
            Payment records are kept without your personal details, as the law requires for accounting. We send a confirmation to your e-mail when this site can send e-mail.
          </Alert>
          <p className="muted text-sm">
            This link no longer shows anything. <AppLink href="/">Back to the home page</AppLink>
          </p>
        </div>
      </FocusedLayout>
    );
  }

  const upcoming = data.bookings.filter(isOpen).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const past = data.bookings.filter((b) => !isOpen(b));
  const open = data.bookings.some((b) => b.reference === openReceipt);

  function item(b: Booking) {
    const href = manageHref(b.manageUrl);
    const expanded = openReceipt === b.reference;
    const panel = `receipt-${b.reference}`;
    return (
      <li key={b.reference} className={cx("portal__item", expanded && "portal__item--open")}>
        <Card>
          <div className="stack">
            <div className="row row--between" style={{ alignItems: "flex-start" }}>
              <div className="stack stack--sm">
                <h3 className="card__title">{b.serviceTitle}</h3>
                <p className="muted text-sm">With {b.influencerName}</p>
              </div>
              <Badge tone={tone(b)}>{b.statusText}</Badge>
            </div>
            <p className="text-sm">{when(b.startTime)}</p>
            {(href || b.receipt) && (
              <div className="row portal__actions no-print">
                {href && <ButtonLink href={href}>Manage</ButtonLink>}
                {b.receipt && (
                  <Button aria-expanded={expanded} aria-controls={panel} onClick={() => setOpenReceipt(expanded ? null : b.reference)}>
                    {expanded ? "Hide receipt" : "Receipt"}
                  </Button>
                )}
              </div>
            )}
            {expanded && b.receipt && <ReceiptCard receipt={b.receipt} id={panel} />}
          </div>
        </Card>
      </li>
    );
  }

  return (
    <FocusedLayout>
      <div className={cx("stack stack--lg portal", open && "portal--receipt-open")}>
        <div className="stack stack--sm portal__chrome">
          <h1 className="focused__title">Your bookings</h1>
          <p className="muted text-sm">
            Bookings made with <strong>{data.email}</strong>. This page works until {clock(data.expiresAt)}.
          </p>
        </div>

        {result && (
          <Alert tone="success" title="Erased" role="status">
            We erased your details from {result.erased} {result.erased === 1 ? "booking" : "bookings"}. {result.blocked} upcoming{" "}
            {result.blocked === 1 ? "booking was" : "bookings were"} kept so the {result.blocked === 1 ? "session" : "sessions"} can still happen.
            Cancel {result.blocked === 1 ? "it" : "them"} first, then erase again.
          </Alert>
        )}
        {error && <Alert tone="danger">{error}</Alert>}

        {data.bookings.length === 0 && (
          <EmptyState title="No paid bookings">
            We have no paid bookings under this address. You can still download or erase the data we hold below.
          </EmptyState>
        )}

        {upcoming.length > 0 && (
          <section className="stack" aria-labelledby="portal-upcoming">
            <h2 className="portal__heading" id="portal-upcoming">Upcoming</h2>
            <ul className="stack portal__list" role="list">{upcoming.map(item)}</ul>
          </section>
        )}
        {past.length > 0 && (
          <section className="stack" aria-labelledby="portal-past">
            <h2 className="portal__heading" id="portal-past">Past and cancelled</h2>
            <ul className="stack portal__list" role="list">{past.map(item)}</ul>
          </section>
        )}
        {data.bookings.length >= 200 && <p className="subtle text-sm portal__chrome">Showing the newest 200 bookings. The download has all of them.</p>}

        <div className="portal__chrome no-print">
          <Card title="Your data">
            <div className="stack">
              <p className="text-sm">
                Download everything we hold under this address (your details, answers, payments and messages) as one file, or erase your
                personal details from your past bookings.
              </p>
              <div className="row">
                <a className="btn" href={`/api/customer/portal/${encodeURIComponent(token)}/export`} download>
                  <IconDownload size={16} /> Download my data (JSON)
                </a>
                <Button variant="danger" onClick={() => setConfirm(true)} disabled={data.erasable === 0}>
                  <IconTrash size={16} /> Erase my data
                </Button>
              </div>
              {data.erasable === 0 && <p className="subtle text-sm">{data.blocked > 0 ? "Your upcoming bookings keep their details until they are cancelled." : "There is nothing left to erase."}</p>}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={erase}
        busy={busy}
        danger
        title="Erase your data?"
        description="This cannot be undone."
        confirmLabel="Erase my data"
        cancelLabel="Keep my data"
      >
        <div className="stack text-sm">
          <p>
            <strong>Erased</strong> from {data.erasable} {data.erasable === 1 ? "booking" : "bookings"} with every host: your name, e-mail address,
            phone number, time zone and your answers to booking questions.
          </p>
          <p>
            <strong>Kept:</strong> payment records (amounts and references, without your personal details), because the law requires them for accounting
            {data.blocked > 0 ? `; and ${data.blocked} upcoming ${data.blocked === 1 ? "booking" : "bookings"}, until you cancel ${data.blocked === 1 ? "it" : "them"}, so the ${data.blocked === 1 ? "session" : "sessions"} can still happen` : ""}.
          </p>
        </div>
      </ConfirmDialog>
    </FocusedLayout>
  );
}
