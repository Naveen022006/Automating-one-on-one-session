import { IconAlertCircle, IconArrowRight, IconCheckCircle } from "@/components/icons";
import { Badge, ButtonLink, Card } from "@/components/ui/primitives";
import type { Readiness } from "@/lib/readiness";

/**
 * "Get your page ready": the connections an influencer needs before customers can book. Required items block the
 * booking page from going live; recommended ones improve the experience (WhatsApp from their own number, email from
 * their own Gmail) but do not block. Hidden once everything is done.
 */
export function GoLiveChecklist({ readiness, live }: { readiness: Readiness; live: boolean }) {
  const open = readiness.items.filter((i) => i.state !== "done");
  if (open.length === 0) return null;
  const doneCount = readiness.items.length - open.length;

  return (
    <Card
      title={live ? "Finish setting up" : "Get your page ready to take bookings"}
      actions={
        <span className="subtle">
          {doneCount} of {readiness.items.length} done
        </span>
      }
    >
      <div className="stack">
        {!live && (
          <p className="muted text-sm">
            Your booking page goes live for customers once the required steps below are done. Until then only you can see it, as a preview.
          </p>
        )}
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {readiness.items.map((i) => (
            <li key={i.key} className="row row--between" style={{ alignItems: "flex-start" }}>
              <div className="row row--nowrap" style={{ alignItems: "flex-start" }}>
                <span style={{ color: i.state === "done" ? "var(--success)" : i.state === "attention" ? "var(--danger)" : "var(--text-muted)", marginTop: 2 }}>
                  {i.state === "done" ? <IconCheckCircle /> : <IconAlertCircle />}
                </span>
                <div>
                  <p style={{ fontWeight: 600 }}>
                    {i.label}{" "}
                    {i.state !== "done" && (i.required ? <Badge tone="warning">Required</Badge> : <Badge>Recommended</Badge>)}
                    {i.state === "attention" && <Badge tone="danger">Needs action</Badge>}
                  </p>
                  <p className="muted text-sm">{i.detail}</p>
                </div>
              </div>
              {i.state !== "done" && (
                <ButtonLink href={i.href} size="sm" variant={i.required ? "primary" : "secondary"}>
                  {i.state === "attention" ? "Fix" : "Set up"} <IconArrowRight size={16} />
                </ButtonLink>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
