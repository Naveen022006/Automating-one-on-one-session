/**
 * Real product UI rendered with the design system and the seeded demo data (prisma/seed.ts), used on the landing
 * page instead of stock illustrations. Static (no data fetching), so the landing page stays fast.
 */
import { IconCheckCircle, IconClock, IconUsers, IconVideo } from "@/components/icons";
import { Avatar, Badge, StatusPill } from "@/components/ui/primitives";

function Frame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div className="frame" aria-hidden="true">
      <div className="frame__bar">
        <span />
        <span />
        <span />
        <span className="frame__url">{url}</span>
      </div>
      <div className="frame__body">{children}</div>
    </div>
  );
}

export function BookingFragment() {
  const times = ["10:00", "10:30", "11:00", "11:30", "14:00", "14:30"];
  return (
    <Frame url="yourname/demo/book">
      <div className="stack">
        <div className="row row--nowrap">
          <Avatar name="Demo Creator" />
          <div>
            <p style={{ fontWeight: 600 }}>1:1 Career Call</p>
            <p className="subtle">30 min · Google Meet · ₹499</p>
          </div>
        </div>
        <p className="slot-group__label" style={{ margin: 0 }}>Tuesday, 13 October · Morning</p>
        <div className="slots">
          {times.map((t, i) => (
            <span key={t} className="slot" aria-pressed={i === 2}>
              {t}
            </span>
          ))}
        </div>
        <span className="btn btn--primary btn--block">Hold 11:00 and pay ₹499</span>
        <p className="subtle">Times shown in Asia/Kolkata</p>
      </div>
    </Frame>
  );
}

export function WhatsAppFragment() {
  return (
    <div className="phone" aria-hidden="true">
      <div className="bubble">
        Your 1:1 Career Call session with Demo Creator on Tue, 13 Oct 2026, 11:00 am IST is confirmed. Join here:
        meet.google.com/abc-defg-hij
        <div className="bubble__meta">11:02</div>
      </div>
      <div className="bubble">
        Reminder: 1:1 Career Call with Demo Creator is tomorrow, Tue, 13 Oct 2026, 11:00 am IST.
        <div className="bubble__meta">Mon 11:00</div>
      </div>
      <div className="bubble">
        1:1 Career Call starts in 15 minutes. Join here: meet.google.com/abc-defg-hij
        <div className="bubble__meta">10:45</div>
      </div>
    </div>
  );
}

export function DashboardFragment() {
  const rows = [
    { name: "Ananya R.", service: "1:1 Career Call", when: "Tue 11:00", status: "SCHEDULED" },
    { name: "Small Group Workshop", service: "4 of 5 seats", when: "Wed 17:00", status: "SCHEDULED", group: true },
    { name: "Rahul M.", service: "1:1 Career Call", when: "Thu 10:30", status: "PAID" },
  ];
  return (
    <Frame url="dashboard">
      <div className="stack">
        <div className="row row--between">
          <p style={{ fontWeight: 600 }}>Next 7 days</p>
          <Badge tone="accent" plain>
            3 sessions
          </Badge>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>
                    <div className="row row--nowrap" style={{ gap: 8 }}>
                      {r.group ? <IconUsers /> : <IconVideo />}
                      <div>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <div className="subtle">{r.service}</div>
                      </div>
                    </div>
                  </td>
                  <td className="tabular">{r.when}</td>
                  <td>
                    <StatusPill kind="booking" status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Frame>
  );
}

export function RemindersFragment() {
  const items = [
    { icon: <IconCheckCircle />, title: "Payment confirmed", detail: "Razorpay webhook verified" },
    { icon: <IconVideo />, title: "Meet link created", detail: "On your Google Calendar, customer invited" },
    { icon: <IconCheckCircle />, title: "WhatsApp delivered", detail: "SMS used only if WhatsApp fails" },
    { icon: <IconClock />, title: "Reminders scheduled", detail: "24 hours and 15 minutes before" },
  ];
  return (
    <Frame url="dashboard/sessions">
      <ol className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((it) => (
          <li key={it.title} className="row row--nowrap" style={{ alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)" }}>{it.icon}</span>
            <div>
              <div style={{ fontWeight: 600 }}>{it.title}</div>
              <div className="subtle">{it.detail}</div>
            </div>
          </li>
        ))}
      </ol>
    </Frame>
  );
}
