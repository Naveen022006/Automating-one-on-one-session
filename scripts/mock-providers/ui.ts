import { FAULTS, FaultError, clearFaults, faultValue, setFault } from "./faults";
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

export function registerUi(router: Router): void {
  router.add("GET", /^\/$/, (c) => c.redirect("/__mock"));
  router.add("GET", /^\/favicon\.ico$/, (c) => c.sendEmpty(204));
  router.add("GET", /^\/__mock\/?$/, overview);
  router.add("GET", /^\/__mock\/requests$/, requestsPage);
  router.add("GET", /^\/__mock\/faults$/, faultsPage);
  router.add("GET", /^\/__mock\/state\.json$/, stateJson);

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
