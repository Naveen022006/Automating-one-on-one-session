import { FAULTS, FaultError, clearFaults, faultValue, setFault } from "./faults";
import { META_APP_ID } from "./fixtures";
import { HttpError, addControl, type Ctx, type Router, type Runtime } from "./http";
import { deleteStateFile, emptyState } from "./state";

/**
 * The owner's view of the mock: /__mock (the story of what happened, in order), one page per provider area, the request log and
 * the failure controls. Server-rendered HTML, no JavaScript. EVERY dynamic value goes through esc(): customer names, email
 * subjects and bodies come from booking input, so an unescaped value here would be a stored XSS in the owner's browser.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"'`]/g, (ch) => ESC[ch]);

/** HH:MM:SS in the viewer's local time (this server runs on the viewer's machine). */
export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleTimeString("en-GB");
}

/** A date and time in local time, for event times. */
export function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export const TABS: [string, string][] = [
  ["", "Overview"],
  ["google", "Google"],
  ["gmail", "Gmail"],
  ["meta", "Meta"],
  ["whatsapp", "WhatsApp"],
  ["sms", "SMS"],
  ["webhooks", "Webhooks"],
  ["requests", "Requests"],
  ["faults", "Faults"],
];

const CSS = `
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fafafa;--muted:#666;--line:#d8d8d8;--card:#fff;--warn:#b00020}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#a0a0a0;--line:#383838;--card:#202020;--warn:#ff6b81}}
body{margin:0;font:14px/1.45 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
.banner{background:var(--warn);color:#fff;padding:8px 16px;font-weight:600}
.banner a{color:#fff}
nav{display:flex;flex-wrap:wrap;gap:4px;padding:8px 16px;border-bottom:1px solid var(--line)}
nav a{padding:4px 10px;border-radius:6px;text-decoration:none;color:var(--fg)}
nav a.on{background:var(--fg);color:var(--bg)}
main{padding:16px;max-width:1200px}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;background:var(--card);margin:8px 0}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
th{background:rgba(128,128,128,.12)}
code,.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
.muted{color:var(--muted)}.warn{color:var(--warn)}.ok{color:#177a3c}
.box{border:1px solid var(--line);background:var(--card);padding:10px 12px;margin:8px 0;border-radius:6px}
form.inline{display:inline}
button,input,select{font:inherit}
button{padding:3px 10px;cursor:pointer}
ul.feed{list-style:none;margin:0;padding:0}ul.feed li{padding:3px 0;border-bottom:1px solid var(--line)}
iframe{width:100%;height:320px;border:1px solid var(--line);background:#fff}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);padding:8px}
`;

export interface PageOptions {
  title: string;
  /** The tab to highlight ("" = overview). */
  tab: string;
  body: string;
  /** Reload the page every N seconds (the live view). */
  refresh?: number;
}

/** The common frame of every owner page: the red banner, the tabs, the control token for the forms on it. */
export function renderPage(o: PageOptions): string {
  const nav = TABS.map(([slug, label]) => `<a href="/__mock${slug ? `/${slug}` : ""}"${slug === o.tab ? ' class="on"' : ""}>${esc(label)}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} - MOCK providers</title>${o.refresh ? `<meta http-equiv="refresh" content="${esc(o.refresh)}">` : ""}<style>${CSS}</style></head><body>
<div class="banner">MOCK PROVIDERS. Nothing here is Google or Meta. Real review, delivery and consent behave differently: see <a href="/__mock#not-proved">What this does not prove</a>.</div>
<nav>${nav}</nav><main><h1>${esc(o.title)}</h1>${o.body}</main></body></html>`;
}

/** A page of the mock's pretend providers (consent, sign-up window, Meet room): the red banner, no owner navigation. */
export function renderPlainPage(o: { title: string; banner: string; body: string; script?: { nonce: string; code: string } }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title><style>${CSS}</style></head><body><div class="banner">${esc(o.banner)}</div><main style="max-width:640px">${o.body}</main>${
    o.script ? `<script nonce="${esc(o.script.nonce)}">${o.script.code}</script>` : ""
  }</body></html>`;
}

/** Sends a frame page. `live` is `?live=N` of the request (a refresh interval in seconds). */
export function sendPage(c: Ctx, o: Omit<PageOptions, "refresh">): void {
  const live = Number(c.query.get("live"));
  c.sendHtml(200, renderPage({ ...o, ...(Number.isInteger(live) && live >= 1 && live <= 60 ? { refresh: live } : {}) }));
}

/** A small POST form for a control action: carries the control token and where to come back to. */
export function ctrlForm(c: Ctx, action: string, back: string, label: string, hidden: Record<string, string> = {}, extra = ""): string {
  const fields = { _mock: c.rt.controlToken, _back: back, ...hidden };
  const inputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<form class="inline" method="post" action="${esc(action)}">${inputs}${extra}<button>${esc(label)}</button></form>`;
}

/** The short form of a secret-like value for display: the kind of token and its last characters. */
export const shortToken = (t: string): string => (t.length > 14 ? `${t.slice(0, 14)}…${t.slice(-6)}` : t);

/** "MOCK-NOT-REAL-…" tokens shortened to their last 6 characters, wamids excepted (they are ids the app stores). */
const SECRET_IN_JSON = /(?<!wamid\.)MOCK-NOT-REAL-[A-Za-z0-9-]+/g;
export function redactState(json: string): string {
  return json.replace(SECRET_IN_JSON, (m) => `MOCK-NOT-REAL-…${m.slice(-6)}`);
}

function counts(rt: Runtime): [string, number, string][] {
  const g = rt.state.google;
  const events = Object.values(g.calendars).reduce((n, cal) => n + Object.values(cal).filter((e) => e.status === "confirmed").length, 0);
  const mails = Object.values(g.sentMail).reduce((n, list) => n + list.length, 0);
  const grants = Object.values(g.grants).filter((x) => !x.revokedAt).length;
  const wa = Object.keys(rt.state.meta.messages).length;
  return [
    ["Google grants", grants, "/__mock/google"],
    ["Calendar events", events, "/__mock/google"],
    ["Gmail messages", mails, "/__mock/gmail"],
    ["WhatsApp messages", wa, "/__mock/whatsapp"],
    ["SMS", rt.state.sms.length, "/__mock/sms"],
    ["Webhook deliveries", rt.state.webhooks.log.length, "/__mock/webhooks"],
  ];
}

const NOT_PROVED = `
<h2 id="not-proved">What this does not prove</h2>
<div class="box"><p>This mock exercises the app's side only. It is written from the same understanding of Google and Meta as the app,
so where that understanding is wrong, both are wrong together and everything here still passes. Real providers behave differently in
these ways, among others:</p><ul>
<li><b>Google:</b> the unverified-app screen, test-user limits and the verification and security assessment for the restricted gmail.send scope;
Testing-mode refresh tokens expire after 7 days; real Meet creation can take a moment or fail; Google really emails the invitations (here they are only logged);
the exact scope string, tombstone lifetime, etag format, quotas and Gmail deliverability are not reproduced.</li>
<li><b>Meta:</b> the real Embedded Signup dialog and its message format and timing (this popup only sends the shape the app expects); Tech Provider approval;
template review takes minutes to 24 hours and may reject or re-categorise (here it is a timer); error codes other than 190, 10, 133005 and 133008 are approximations;
messaging limits, quality rating and the 24-hour window; webhook retries for days, batching, duplicates and out-of-order delivery;
Meta cannot reach localhost, so a real webhook needs a public HTTPS URL.</li>
<li><b>SMS:</b> DLT registration and the real MSG91 or Twilio behaviour. <b>Razorpay:</b> nothing is mocked here, the real test mode is used.</li></ul>
<p>Meet links here point at this server (<code>/meet/mock-…</code>), never at meet.google.com, so a demo customer can never land in a stranger's call.</p></div>`;

function overview(c: Ctx): void {
  const rt = c.rt;
  const cards = counts(rt)
    .map(([label, n, href]) => `<a class="box" style="display:inline-block;margin-right:8px;min-width:130px;text-decoration:none;color:inherit" href="${esc(href)}"><div class="muted">${esc(label)}</div><div style="font-size:22px;font-weight:600">${n}</div></a>`)
    .join("");
  const feed = [...rt.state.activity]
    .reverse()
    .slice(0, 200)
    .map((a) => `<li><span class="muted mono">${clock(a.at)}</span> ${a.link ? `<a href="${esc(a.link)}">${esc(a.text)}</a>` : esc(a.text)}</li>`)
    .join("");
  sendPage(c, {
    title: "Overview",
    tab: "",
    body: `<p class="muted">Control page of the local mock for Google and Meta. App: <code>${esc(rt.appUrl)}</code> · mock: <code>${esc(rt.origin)}</code> ·
<a href="?live=3">live view (refresh every 3 s)</a></p>${cards}<h2>What happened</h2>
${feed ? `<ul class="feed">${feed}</ul>` : '<p class="muted">Nothing yet. Connect Google or WhatsApp from the app\'s Settings page, or make a booking.</p>'}${NOT_PROVED}`,
  });
}

function requestsPage(c: Ctx): void {
  const rows = [...c.rt.state.requests]
    .reverse()
    .map(
      (r) =>
        `<tr><td class="mono">${clock(r.at)}</td><td>${esc(r.method)}</td><td class="mono">${esc(r.path)}${r.ifMatch ? " <span class=\"muted\">[If-Match]</span>" : ""}</td><td>${esc(r.status || "reset")}</td><td>${esc(r.ms)} ms</td><td class="mono">${esc(r.fault ?? "")}</td><td class="mono">${esc(r.auth ?? "")}</td></tr>`,
    )
    .join("");
  sendPage(c, {
    title: "Requests",
    tab: "requests",
    body: `<p class="muted">The last ${c.rt.state.requests.length} requests the mock answered. Secrets in query strings are redacted; a token the mock did not mint is never recorded.</p>
<table><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Time taken</th><th>Fault applied</th><th>Authorization</th></tr>${rows}</table>`,
  });
}

function faultsPage(c: Ctx): void {
  const rt = c.rt;
  const rows = Object.entries(FAULTS)
    .map(([key, def]) => {
      const current = faultValue(rt, key);
      const set = rt.state.faults[key];
      const list = `opts-${key.replace(/\W/g, "-")}`;
      const extra = `<input name="value" value="${esc(current)}" list="${esc(list)}" size="22"><datalist id="${esc(list)}">${def.options.map((o) => `<option value="${esc(o)}">`).join("")}</datalist> <label><input type="checkbox" name="once" value="1"> once</label> `;
      return `<tr><td class="mono">${esc(key)}</td><td class="${set ? "warn" : "muted"}">${esc(current)}${set?.once ? " (once)" : ""}</td><td>${esc(def.help)}</td><td>${ctrlForm(c, "/__mock/faults", "/__mock/faults", "Set", { key }, extra)}</td></tr>`;
    })
    .join("");
  sendPage(c, {
    title: "Faults",
    tab: "faults",
    body: `<p>Switch a failure on to see how the app copes. Setting a fault to its default clears it. <b>once</b> applies it to the next matching request only.</p>
<table><tr><th>Fault</th><th>Now</th><th>What it shows in the app</th><th>Change</th></tr>${rows}</table>
<p>${ctrlForm(c, "/__mock/faults/clear", "/__mock/faults", "Clear every fault")}</p>
<h2>Start over</h2><p class="muted">Forgets every fake account, grant, event, message and template. Everything the app stored a token for is then unknown to the mock, and the app shows its real "Reconnect needed" states.</p>
<p>${ctrlForm(c, "/__mock/reset", "/__mock", "Reset the mock", { confirm: "reset" })}</p>`,
  });
}

/** The state without the secrets in it (their last 6 characters only), unless the control token asks for everything. */
function stateJson(c: Ctx): void {
  const json = JSON.stringify(c.rt.state, null, 2);
  const full = c.query.get("full") === "1";
  if (full) {
    const token = c.header("x-mock-control") ?? c.query.get("_mock");
    if (token !== c.rt.controlToken) throw new HttpError(403, { error: "full=1 needs the control token" });
  }
  c.sendText(200, full ? json : redactState(json), { "Content-Type": "application/json; charset=utf-8" });
}

/** Forgets everything. Keeps the process's settings (the app URL and webhook target). */
export function resetState(rt: Runtime): void {
  const fresh = emptyState(rt.now());
  const target = rt.state.webhooks.target;
  Object.assign(rt.state, fresh);
  rt.state.webhooks.target = target;
  deleteStateFile(rt.stateFile);
  rt.save();
  rt.activity("The mock was reset: every fake account, token and message is gone");
}

/* ---------- Google ---------- */

const shortScope = (s: string) => s.replace("https://www.googleapis.com/auth/", "");

function googlePage(c: Ctx): void {
  const rt = c.rt;
  const g = rt.state.google;
  const back = "/__mock/google";
  const grants = Object.entries(g.grants)
    .reverse()
    .map(([id, gr]) => {
      const live = !gr.revokedAt;
      return `<tr><td>${esc(gr.email)}</td><td class="mono">${esc(id)}</td><td>${esc(gr.scopes.map(shortScope).join(", "))}</td><td>${when(gr.createdAt)}</td>
<td class="${live ? "ok" : "warn"}">${live ? "active" : `revoked ${when(gr.revokedAt!)}`}</td><td>${live ? ctrlForm(c, "/__mock/google/revoke-grant", back, "Revoke this grant", { grantId: id }) : ""}</td></tr>`;
    })
    .join("");
  const accessTokens = Object.values(g.accessTokens);
  const live = accessTokens.filter((t) => t.expiresAt > rt.now()).length;

  const calendars = Object.entries(g.calendars)
    .map(([account, events]) => {
      const rows = Object.values(events)
        .reverse()
        .map((e) => {
          const link = e.conference?.status === "success" && e.conference.code ? `/meet/${e.conference.code}` : null;
          const meet = link ? `<a href="${esc(link)}">${esc(rt.origin + link)}</a>` : e.conference ? esc(`Meet ${e.conference.status}`) : "";
          const state = e.purged ? "purged (410)" : e.status === "cancelled" ? "deleted (tombstone)" : e.status;
          const action = e.status === "cancelled" ? "" : ctrlForm(c, "/__mock/google/delete-event", back, "Delete behind the app's back", { account, eventId: e.id });
          return `<tr id="event-${esc(e.id)}"><td>${esc(e.summary)}<div class="muted mono">${esc(e.id)}</div></td><td>${when(e.start.dateTime)}<br>${when(e.end.dateTime)}</td><td class="${e.status === "cancelled" ? "warn" : ""}">${esc(state)}</td>
<td>${e.attendees.map((a) => esc(a.email)).join("<br>")}</td><td class="mono">${meet}</td><td>etag ${e.etag}<br>sequence ${e.seq}</td>
<td><details><summary>${e.history.length} entries</summary>${e.history.map((h) => `<div class="mono">${esc(h)}</div>`).join("")}</details></td><td>${action}</td></tr>`;
        })
        .join("");
      return `<h2>Calendar of ${esc(account)}</h2><table><tr><th>Event</th><th>When</th><th>Status</th><th>Attendees</th><th>Meet link</th><th>Version</th><th>History</th><th></th></tr>${rows}</table>`;
    })
    .join("");
  const invites = [...g.invites]
    .reverse()
    .slice(0, 100)
    .map((i) => `<tr><td class="mono">${clock(i.at)}</td><td>${esc(i.kind)}</td><td>${esc(i.to)}</td><td class="mono"><a href="#event-${esc(i.eventId)}">${esc(i.eventId.slice(0, 12))}…</a></td><td>${esc(i.account)}</td></tr>`)
    .join("");

  sendPage(c, {
    title: "Google",
    tab: "google",
    body: `<p class="muted">Pretend Google accounts that allowed the app (OAuth grants), and their calendars. Real Google also shows an "unverified app" screen, limits Testing-mode tokens to 7 days and really emails the invitations.</p>
<h2>Accounts and grants</h2>${grants ? `<table><tr><th>Account</th><th>Grant</th><th>Allowed</th><th>Since</th><th>Status</th><th></th></tr>${grants}</table>` : '<p class="muted">No grant yet: connect Google from the app\'s Settings page.</p>'}
<p>${accessTokens.length} access token(s), ${live} still valid. ${ctrlForm(c, "/__mock/google/expire-access", back, "Expire all access tokens")} <span class="muted">(the app must refresh them)</span>
 ${ctrlForm(c, "/__mock/google/purge", back, "Purge deleted events")} <span class="muted">(tombstones then answer 410)</span></p>
${calendars || '<p class="muted">No calendar events yet.</p>'}
<h2>Invitations Google would have emailed</h2>${invites ? `<table><tr><th>Time</th><th>Kind</th><th>To</th><th>Event</th><th>Calendar</th></tr>${invites}</table>` : '<p class="muted">None yet. The mock only logs them; real Google sends the emails.</p>'}`,
  });
}

/* ---------- Gmail ---------- */

function gmailPage(c: Ctx): void {
  const all = Object.values(c.rt.state.google.sentMail)
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at));
  const id = c.query.get("id");
  const mail = id ? all.find((m) => m.id === id) : null;
  if (id && !mail) return sendPage(c, { title: "Gmail", tab: "gmail", body: '<p class="warn">No such message.</p><p><a href="/__mock/gmail">Back to the outbox</a></p>' });
  if (mail) {
    const rewrite = mail.fromRewritten
      ? `<p class="warn">The From address (${esc(mail.from)}) is not the connected account (${esc(mail.account)}). Gmail would rewrite it or refuse it.</p>`
      : "";
    return sendPage(c, {
      title: "Gmail message",
      tab: "gmail",
      body: `<p><a href="/__mock/gmail">Back to the outbox</a></p>${rewrite}
<table><tr><th>Sent by account</th><td>${esc(mail.account)}</td></tr><tr><th>From</th><td>${esc(mail.fromDisplay)}</td></tr><tr><th>To</th><td>${esc(mail.toDisplay)}</td></tr>
<tr><th>Reply-To</th><td>${esc(mail.replyTo ?? "")}</td></tr><tr><th>Subject</th><td>${esc(mail.subject)}</td></tr><tr><th>Sent</th><td>${when(mail.at)}</td></tr>
<tr><th>Message id</th><td class="mono">${esc(mail.id)} (the app stores gmail:${esc(mail.id)})</td></tr></table>
<h2>Text part</h2><pre>${esc(mail.text)}</pre>
<h2>HTML part</h2><p class="muted">Shown in a sandboxed frame without scripts, links or forms working. If your browser shows nothing here, read the text part above.</p>
<iframe sandbox srcdoc="${esc(mail.html)}" title="HTML part of the message"></iframe>`,
    });
  }
  const rows = all
    .map((m) => `<tr><td class="mono">${clock(m.at)}</td><td>${esc(m.account)}</td><td>${esc(m.to)}</td><td><a href="/__mock/gmail?id=${esc(m.id)}">${esc(m.subject)}</a></td><td>${m.fromRewritten ? '<span class="warn">From differs</span>' : ""}</td></tr>`)
    .join("");
  sendPage(c, {
    title: "Gmail",
    tab: "gmail",
    body: `<p class="muted">Emails the app sent through an influencer's Gmail (users.messages.send). Real Gmail deliverability, spam placement, daily limits and From rewriting are not reproduced.</p>
${rows ? `<table><tr><th>Time</th><th>Account</th><th>To</th><th>Subject</th><th></th></tr>${rows}</table>` : '<p class="muted">Nothing sent yet.</p>'}`,
  });
}

/* ---------- Meta ---------- */

function metaPage(c: Ctx): void {
  const rt = c.rt;
  const m = rt.state.meta;
  const back = "/__mock/meta";
  const minted = c.query.get("token");
  const mintedBox = minted && m.tokens[minted] ? `<div class="box"><b>New token</b> (shown once on this page, copy it now; it is fake):<br><code>${esc(minted)}</code></div>` : "";

  const phoneRows = (wabaId: string) =>
    m.wabas[wabaId].phoneIds
      .map((pid) => {
        const p = m.phones[pid];
        const lockedNow = p.lockedUntil !== null && Date.parse(p.lockedUntil) > rt.now();
        const form = (action: string, label: string, extra = "") => ctrlForm(c, "/__mock/meta/phone", back, label, { phoneId: pid, action }, extra);
        return `<tr><td>${esc(p.display)}<div class="mono muted">${esc(p.id)}</div></td><td>${esc(p.verifiedName)}</td><td>${p.registered ? "yes" : "no"}</td><td>${p.pin ? "yes" : "no"}</td>
<td class="${lockedNow ? "warn" : ""}">${lockedNow ? `locked until ${clock(p.lockedUntil!)}` : p.wrongAttempts ? `${p.wrongAttempts} wrong guess(es)` : "no"}</td>
<td>${form(lockedNow ? "unlock" : "lock", lockedNow ? "Unlock" : "Lock")} ${form("clear-pin", "Remove PIN")} ${form("unregister", "Unregister")} ${form("set-pin", "Set PIN", '<input name="pin" value="654321" size="6" maxlength="6"> ')}</td></tr>`;
      })
      .join("");

  const wabaBlocks = Object.values(m.wabas)
    .map((w) => {
      const own = Object.values(w.templates).filter((t) => !t.name.startsWith("mock_filler_"));
      const hidden = Object.keys(w.templates).length - own.length;
      const templates = own
        .map((t) => {
          const act = (action: string, label: string) => ctrlForm(c, "/__mock/meta/template", back, label, { wabaId: w.id, templateId: t.id, action, ...(action === "reject" ? { reason: "INVALID_FORMAT" } : {}) });
          const timer = t.decideAt ? `decides at ${clock(t.decideAt)} (${esc(t.planned?.status ?? "")})` : "";
          return `<tr><td>${esc(t.name)}<div class="muted">${esc(t.language)} · ${esc(t.category)} · ${esc(Object.keys(t.body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).length)} variable(s)</div></td>
<td class="${t.status === "APPROVED" ? "ok" : t.status === "PENDING" ? "" : "warn"}">${esc(t.status)}${t.rejectedReason ? ` (${esc(t.rejectedReason)})` : ""}<div class="muted">${timer}</div></td>
<td>${esc(t.body)}</td><td>${act("approve", "Approve")} ${act("reject", "Reject")} ${act("pause", "Pause")} ${act("disable", "Disable")} ${act("flag", "Flag")} ${act("reinstate", "Reinstate")}</td></tr>`;
        })
        .join("");
      const apps = w.subscribedApps.length ? w.subscribedApps.map((a) => esc(a === META_APP_ID ? `${a} (the platform app: webhooks reach the app)` : `${a} (another app: nothing reaches the app)`)).join(", ") : "none";
      return `<h2>${esc(w.name)} <span class="muted mono">account ${esc(w.id)}</span></h2><p>Subscribed apps: ${apps}</p>
<table><tr><th>Number</th><th>Verified name</th><th>Registered</th><th>PIN set</th><th>PIN locked</th><th>Change</th></tr>${phoneRows(w.id)}</table>
${own.length ? `<table><tr><th>Template</th><th>Status</th><th>Body</th><th>Review it yourself</th></tr>${templates}</table>` : '<p class="muted">No templates.</p>'}${hidden ? `<p class="muted">${hidden} unrelated filler templates are not shown (they make the list several pages long).</p>` : ""}`;
    })
    .join("");

  const tokens = Object.entries(m.tokens)
    .reverse()
    .map(([token, tk]) => {
      const state = tk.revokedAt ? "revoked" : tk.expiresAt !== null && tk.expiresAt * 1000 <= rt.now() ? "expired" : "valid";
      return `<tr><td>${esc(tk.label)}<div class="mono muted">${esc(shortToken(token))}</div></td><td>${tk.appId === META_APP_ID ? "platform app" : "influencer's own app"}</td><td>${esc(tk.scopes.join(", ") || "none")}</td>
<td>${tk.expiresAt === null ? "never" : when(new Date(tk.expiresAt * 1000).toISOString())}</td><td class="${state === "valid" ? "ok" : "warn"}">${state}</td>
<td>${state === "valid" ? `${ctrlForm(c, "/__mock/meta/revoke-token", back, "Revoke this token", { token })} ${ctrlForm(c, "/__mock/meta/expire-token", back, "Expire", { token })}` : ""}</td></tr>`;
    })
    .join("");

  const wabaBoxes = Object.values(m.wabas)
    .map((w, i) => `<label style="display:block"><input type="checkbox" name="wabaIds" value="${esc(w.id)}"${i === 0 ? " checked" : ""}> ${esc(w.name)} <span class="mono">${esc(w.id)}</span></label>`)
    .join("");
  const kit = `<h2 id="kit">Manual connect kit</h2>${mintedBox}
<p class="muted">For "Enter details manually" in the app's WhatsApp settings: copy an account id and a phone number id from the lists below, mint a token here, paste all three. A "platform app" token is the kind our webhooks work with; an "own app" token is the wrong app on purpose (the app should say so). Real tokens come from a System User in Business settings.</p>
<form method="post" action="/__mock/meta/mint-token" class="box"><input type="hidden" name="_mock" value="${esc(rt.controlToken)}"><input type="hidden" name="_back" value="/__mock/meta">
<p><label>Token of <select name="app"><option value="platform">the platform app</option><option value="own">the influencer's own app</option></select></label>
 <label>Expires <select name="expiresInDays"><option value="0">never</option><option value="1">in 1 day</option><option value="30">in 30 days</option></select></label></p>
<p>Permissions: <label><input type="checkbox" name="scopes" value="whatsapp_business_management" checked> whatsapp_business_management</label> <label><input type="checkbox" name="scopes" value="whatsapp_business_messaging" checked> whatsapp_business_messaging</label></p>
<p>Accounts it can use:</p>${wabaBoxes}<p><button>Mint token</button></p></form>`;

  sendPage(c, {
    title: "Meta",
    tab: "meta",
    body: `<p class="muted">Pretend WhatsApp Business accounts, numbers and message templates. <b>Real Meta review takes minutes to 24 hours and may reject or re-categorise a template</b>; here a timer decides (see the meta.review fault).
Embedded Signup here is a mock window that sends the message shape the app expects, not Meta's real dialog.</p>${kit}${wabaBlocks}
<h2>Access tokens</h2>${tokens ? `<table><tr><th>Token</th><th>App</th><th>Permissions</th><th>Expires</th><th>State</th><th></th></tr>${tokens}</table>` : '<p class="muted">No token yet. Embedded Signup and the kit above create them.</p>'}`,
  });
}

/* ---------- WhatsApp, SMS, webhooks ---------- */

function whatsappPage(c: Ctx): void {
  const rows = Object.values(c.rt.state.meta.messages)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((msg) => {
      const timeline = msg.statuses.length
        ? msg.statuses.map((s) => `${esc(s.status)} <span class="muted">${clock(s.at)}${s.webhook ? ` · webhook ${esc(s.webhook)}` : ""}</span>`).join("<br>")
        : '<span class="muted">accepted, no status yet</span>';
      return `<tr id="msg-${esc(msg.id)}"><td class="mono">${clock(msg.at)}</td><td>${esc(msg.to)}</td><td>${esc(msg.template)}<div class="muted">${esc(msg.language)}</div></td><td>${esc(msg.rendered)}<div class="mono muted">${esc(msg.id)}</div></td><td>${timeline}</td></tr>`;
    })
    .join("");
  sendPage(c, {
    title: "WhatsApp",
    tab: "whatsapp",
    body: `<p class="muted">Template messages the app sent through the Cloud API. Statuses (sent, delivered, read) come from a timer and reach the app as signed webhooks; real Meta limits, quality ratings and the 24-hour window are not reproduced.</p>
${rows ? `<table><tr><th>Time</th><th>To</th><th>Template</th><th>Message as the customer sees it</th><th>Status timeline</th></tr>${rows}</table>` : '<p class="muted">No WhatsApp message yet.</p>'}`,
  });
}

function smsPage(c: Ctx): void {
  const rows = [...c.rt.state.sms]
    .reverse()
    .map((s) => `<tr><td class="mono">${clock(s.at)}</td><td>${esc(s.to)}</td><td>${esc(s.body)}</td><td class="mono">${esc(s.id)}</td></tr>`)
    .join("");
  sendPage(c, {
    title: "SMS",
    tab: "sms",
    body: `<p class="muted">The SMS fallback (SMS_PROVIDER=generic pointing here). Real SMS needs DLT registration and an MSG91 or Twilio account; they are not mocked.</p>
${rows ? `<table><tr><th>Time</th><th>To</th><th>Message</th><th>Id</th></tr>${rows}</table>` : '<p class="muted">No SMS yet. The app sends one when WhatsApp is not connected or fails.</p>'}`,
  });
}

function webhooksPage(c: Ctx): void {
  const w = c.rt.state.webhooks;
  const rows = [...w.log]
    .reverse()
    .map((e) => `<tr><td class="mono">${clock(e.at)}</td><td>${esc(e.kind)}</td><td>${e.attempt || ""}</td><td class="${e.status === 200 ? "ok" : "warn"}">${esc(e.status ?? "")}</td><td>${esc(e.error ?? "")}</td><td class="mono">${esc(e.bodyPreview)}</td></tr>`)
    .join("");
  sendPage(c, {
    title: "Webhooks",
    tab: "webhooks",
    body: `<p class="muted">What the mock sends to the app as Meta would: template approvals and message statuses, signed with the fake app secret. Real Meta retries for days, can batch several updates in one POST, can deliver duplicates or out of order, and cannot reach localhost at all.</p>
<form method="post" action="/__mock/webhooks/target" class="box"><input type="hidden" name="_mock" value="${esc(c.rt.controlToken)}"><input type="hidden" name="_back" value="/__mock/webhooks">
<label>Target <input name="url" value="${esc(w.target)}" size="52"></label> <button>Change</button> <span class="muted">(local addresses only)</span></form>
<p>${ctrlForm(c, "/__mock/webhooks/verify", "/__mock/webhooks", "Run the verify handshake")} <span class="muted">sends the GET Meta sends when the webhook is configured; the result is in the story on the overview page</span></p>
${rows ? `<table><tr><th>Time</th><th>What</th><th>Attempt</th><th>Answer</th><th>Problem</th><th>Start of the app's answer</th></tr>${rows}</table>` : '<p class="muted">Nothing delivered yet.</p>'}`,
  });
}

/* ---------- the Meet room ---------- */

function meetRoom(c: Ctx): void {
  const code = c.params.code;
  for (const [account, events] of Object.entries(c.rt.state.google.calendars)) {
    for (const e of Object.values(events)) {
      if (e.conference?.code !== code || e.conference.status !== "success") continue;
      return c.sendHtml(
        200,
        renderPlainPage({
          title: "MOCK Meet room",
          banner: "MOCK Meet room. This is not a real meeting and not Google Meet.",
          body: `<h1>${esc(e.summary)}</h1><p>${when(e.start.dateTime)} to ${when(e.end.dateTime)}</p>
<p>Calendar of ${esc(account)} · ${e.status === "cancelled" ? '<b class="warn">this event was deleted</b>' : "scheduled"}</p>
<h2>Attendees</h2><ul>${e.attendees.map((a) => `<li>${esc(a.displayName ?? "")} ${esc(a.email)}</li>`).join("") || "<li>none</li>"}</ul>
<p class="muted">The app stored this link as the session's Meet link. Real Meet links look like https://meet.google.com/abc-defg-hij; the mock never makes one of those, because a random code in that format could be somebody else's live call.</p>`,
        }),
      );
    }
  }
  c.sendHtml(404, renderPlainPage({ title: "MOCK Meet room", banner: "MOCK Meet room. This is not a real meeting and not Google Meet.", body: "<h1>No such room</h1><p>The mock does not know this room (it may have been reset).</p>" }));
}

export function registerUi(router: Router): void {
  router.add("GET", /^\/$/, (c) => c.redirect("/__mock"));
  router.add("GET", /^\/favicon\.ico$/, (c) => c.sendEmpty(204));
  router.add("GET", /^\/__mock\/?$/, overview);
  router.add("GET", /^\/__mock\/google$/, googlePage);
  router.add("GET", /^\/__mock\/gmail$/, gmailPage);
  router.add("GET", /^\/__mock\/meta$/, metaPage);
  router.add("GET", /^\/__mock\/whatsapp$/, whatsappPage);
  router.add("GET", /^\/__mock\/sms$/, smsPage);
  router.add("GET", /^\/__mock\/webhooks$/, webhooksPage);
  router.add("GET", /^\/__mock\/requests$/, requestsPage);
  router.add("GET", /^\/__mock\/faults$/, faultsPage);
  router.add("GET", /^\/__mock\/state\.json$/, stateJson);
  router.add("GET", /^\/meet\/(?<code>[a-z0-9-]{1,40})$/, meetRoom);

  addControl(router, "/__mock/faults", (_c, f) => {
    try {
      setFault(_c.rt, String(f.key ?? ""), String(f.value ?? ""), f.once === true || f.once === "1" || f.once === "true");
    } catch (e) {
      if (e instanceof FaultError) throw new HttpError(400, { error: e.message });
      throw e;
    }
    return { ok: true, faults: _c.rt.state.faults };
  });
  addControl(router, "/__mock/faults/clear", (c) => {
    clearFaults(c.rt);
    return { ok: true };
  });
  addControl(router, "/__mock/reset", (c, f) => {
    if (f.confirm !== "reset") throw new HttpError(400, { error: 'Send { "confirm": "reset" } to reset the mock' });
    resetState(c.rt);
    return { ok: true };
  });
}
