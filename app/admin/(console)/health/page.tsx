import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/app/AppShell";
import { IconCheckCircle, IconSparkline } from "@/components/icons";
import { Alert, Badge, ButtonLink, Card, EmptyState, type Tone } from "@/components/ui/primitives";
import { listFailedJobs, listRecoveredPayments } from "@/lib/admin/health-data";
import { requireAdminPage } from "@/lib/admin/session";
import { formatMoney } from "@/lib/format";
import { collectSnapshot, evaluateHealth, formatAge, thresholdsFromEnv, type ConditionStatus } from "@/lib/health";
import { QUEUE_NAMES } from "@/lib/queue";

export const metadata: Metadata = { title: "System health" };
export const dynamic = "force-dynamic";

const STATUS: Record<ConditionStatus, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "success" },
  warn: { label: "Attention", tone: "warning" },
  critical: { label: "Problem", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
};

const when = (d: Date | number) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" });

export default async function AdminHealthPage() {
  await requireAdminPage("/admin/health");
  const thresholds = thresholdsFromEnv();
  const [snapshot, recovered, failed] = await Promise.all([collectSnapshot({ thresholds }), listRecoveredPayments(10), listFailedJobs(10)]);
  const report = evaluateHealth(snapshot, thresholds);
  const worker = report.conditions.find((c) => c.id === "worker-heartbeat")!;
  const rest = report.conditions.filter((c) => c.id !== "worker-heartbeat");
  const unknownCount = report.conditions.filter((c) => c.status === "unknown").length;
  const lastBeat = snapshot.heartbeat.state === "ok" ? snapshot.heartbeat.at : null;
  const recovery = snapshot.recovery;

  return (
    <div className="stack stack--lg">
      <PageHead
        title="System health"
        description="Is the background worker running, are payments and meetings getting through, and are any jobs stuck?"
        actions={<ButtonLink href="/admin/health" variant="secondary" size="sm">Refresh</ButtonLink>}
      />

      {report.unhealthy.length === 0 ? (
        <Alert tone={unknownCount > 0 ? "info" : "success"} title={unknownCount > 0 ? "No problems found." : "Everything is healthy."}>
          Checked {when(report.at)}.{unknownCount > 0 && ` ${unknownCount} ${unknownCount === 1 ? "check" : "checks"} could not be measured and ${unknownCount === 1 ? "is" : "are"} shown as Unknown.`}
        </Alert>
      ) : (
        <Alert tone={report.unhealthy.some((c) => c.status === "critical") ? "danger" : "warning"} title={`${report.unhealthy.length} ${report.unhealthy.length === 1 ? "condition needs" : "conditions need"} attention`}>
          {report.unhealthy.map((c) => c.label).join(", ")}.
        </Alert>
      )}

      <Card title="Background worker">
        {worker.status === "critical" && (
          <Alert tone="danger" title="Worker is not running">
            {worker.detail} {worker.hint}
          </Alert>
        )}
        <div className="grid grid--3" style={worker.status === "critical" ? { marginTop: 16 } : undefined}>
          <div>
            <span className="subtle">Status</span>
            <p style={{ margin: "4px 0 0" }}>
              <Badge tone={STATUS[worker.status].tone}>{worker.status === "ok" ? "Running" : worker.status === "unknown" ? "Unknown" : "Not running"}</Badge>
            </p>
          </div>
          <div>
            <span className="subtle">Last heartbeat</span>
            <p style={{ margin: "4px 0 0" }}>
              {lastBeat ? (
                <>
                  {when(lastBeat)} <span className="subtle">({formatAge((snapshot.at - lastBeat) / 1000)} ago)</span>
                </>
              ) : (
                <span className="subtle">{snapshot.heartbeat.state === "unknown" ? snapshot.heartbeat.reason : "None recorded"}</span>
              )}
            </p>
          </div>
          <div>
            <span className="subtle">Payment recovery</span>
            <p style={{ margin: "4px 0 0" }}>
              {recovery?.lastRunAt ? (
                <>
                  {when(recovery.lastRunAt)}{" "}
                  <span className="subtle">
                    ({recovery.lastCandidates} checked, {recovery.lastRecovered} recovered)
                  </span>
                </>
              ) : (
                <span className="subtle">No run recorded yet</span>
              )}
            </p>
          </div>
        </div>
      </Card>

      <Card title="Monitored conditions">
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Monitored conditions</caption>
            <thead>
              <tr>
                <th scope="col">Condition</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">Count</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((c) => (
                <tr key={c.id}>
                  <td data-label="Condition">{c.href ? <Link href={c.href}>{c.label}</Link> : c.label}</td>
                  <td data-label="Status">
                    <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                  </td>
                  <td data-label="Count" className="num">
                    {c.value ?? "—"}
                  </td>
                  <td data-label="Details">
                    {c.detail}
                    {c.hint && c.status !== "ok" && <div className="subtle">{c.hint}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="subtle" style={{ marginTop: 12 }}>
          Alerts go to the error webhook and to ADMIN_ALERT_EMAILS, at most once an hour per condition, with a note when it clears.
          Thresholds: worker stale after {thresholds.workerStaleSeconds} s, paid booking without a link after {thresholds.meetingStuckMinutes} min,
          more than {thresholds.queueFailedMax} failed or {thresholds.queueWaitingMax} waiting jobs per queue.
        </p>
      </Card>

      <Card title="Job queues">
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Queue job counts</caption>
            <thead>
              <tr>
                <th scope="col">Queue</th>
                <th scope="col" className="num">Waiting</th>
                <th scope="col" className="num">Active</th>
                <th scope="col" className="num">Delayed</th>
                <th scope="col" className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {QUEUE_NAMES.map((name) => {
                const q = snapshot.queues[name];
                return (
                  <tr key={name}>
                    <td data-label="Queue">{name}</td>
                    <td data-label="Waiting" className="num">{q?.waiting ?? "—"}</td>
                    <td data-label="Active" className="num">{q?.active ?? "—"}</td>
                    <td data-label="Delayed" className="num">{q?.delayed ?? "—"}</td>
                    <td data-label="Failed" className="num">{q ? (q.failed > 0 ? <Badge tone="warning">{q.failed}</Badge> : q.failed) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="subtle" style={{ marginTop: 12 }}>Reminders sit in Delayed until their send time, so a large Delayed count is normal.</p>
      </Card>

      <Card title="Recently recovered payments" actions={<Link href="/admin/audit">Audit log</Link>}>
        <p className="muted" style={{ marginTop: 0 }}>
          Payments Razorpay had captured but whose webhook never reached us, found and booked by the recovery job. Seeing any here means webhook delivery needs a look.
        </p>
        {recovered.length === 0 ? (
          <EmptyState icon={<IconCheckCircle />} title="None">
            No payment has needed recovery.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Recovered payments</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Result</th>
                  <th scope="col">Razorpay payment</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {recovered.map((r) => (
                  <tr key={r.id}>
                    <td data-label="When">{when(r.at)}</td>
                    <td data-label="Result">
                      {r.outcome === "recovered" ? <Badge tone="success">Booked</Badge> : <Badge tone="warning">Needs refund</Badge>}
                    </td>
                    <td data-label="Razorpay payment" className="subtle" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
                      {r.razorpayPaymentId ?? r.paymentId ?? "—"}
                    </td>
                    <td data-label="Amount" className="num">
                      {r.amountMinor !== null && r.currency ? formatMoney(r.amountMinor, r.currency) : "—"}
                    </td>
                    <td data-label="Note" className="subtle">
                      {r.reason ?? (r.bookingId ? `Booking ${r.bookingId}` : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Failed jobs">
        {failed.unavailable.length > 0 && (
          <Alert tone="warning" title="Some queues could not be read">
            Redis did not answer for: {failed.unavailable.join(", ")}.
          </Alert>
        )}
        {failed.jobs.length === 0 ? (
          <EmptyState icon={<IconSparkline />} title="No failed jobs">
            Failed jobs are kept here until someone removes them.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--stack">
              <caption className="sr-only">Failed jobs</caption>
              <thead>
                <tr>
                  <th scope="col">Failed</th>
                  <th scope="col">Queue / job</th>
                  <th scope="col">Booking</th>
                  <th scope="col" className="num">Attempts</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {failed.jobs.map((j) => (
                  <tr key={`${j.queue}:${j.id}`}>
                    <td data-label="Failed">{j.failedAt ? when(j.failedAt) : "—"}</td>
                    <td data-label="Queue / job">
                      {j.queue} · {j.name}
                      <div className="subtle" style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>{j.id}</div>
                    </td>
                    <td data-label="Booking" className="subtle">{j.bookingId ?? "—"}</td>
                    <td data-label="Attempts" className="num">{j.attemptsMade}</td>
                    <td data-label="Reason">{j.failedReason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
