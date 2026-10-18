// The screens of the optional QR-code WhatsApp mode (web/src/components/app/WhatsAppQrLink.tsx, WhatsAppModePicker.tsx,
// web/src/components/admin/InfluencerWhatsAppWebPanel.tsx) and the pure rules behind them (web/src/lib/whatsapp-web-ui.ts).
// No database, no network, no timers: every state is a server render of a view fixture, and the polling, countdown, consent and focus
// rules are pure functions. Only `@web/lib/navigate` is replaced (the official form calls useRouter), before the components are imported.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, mock, test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderQrSvg } from "../lib/whatsapp-web/qr-svg";
import { CONSENT_VERSION, RISK_TEXT, type WhatsAppWebStatus, type WhatsAppWebView } from "../lib/whatsapp-web/types";
import { queryKeys } from "../web/src/lib/query";
import * as ui from "../web/src/lib/whatsapp-web-ui";
import { fakeNavigate } from "./helpers/fake-navigate";

type QrModule = typeof import("../web/src/components/app/WhatsAppQrLink");
type PickerModule = typeof import("../web/src/components/app/WhatsAppModePicker");
type AdminModule = typeof import("../web/src/components/admin/InfluencerWhatsAppWebPanel");
let qr: QrModule;
let picker: PickerModule;
let admin: AdminModule;
// Loaded with import() like the components do, so both see the same module instance (a static import gets the CommonJS build).
let rq: typeof import("@tanstack/react-query");

before(async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/dashboard/settings") });
  qr = await import("../web/src/components/app/WhatsAppQrLink");
  picker = await import("../web/src/components/app/WhatsAppModePicker");
  admin = await import("../web/src/components/admin/InfluencerWhatsAppWebPanel");
  rq = await import("@tanstack/react-query");
});

const render = (el: ReactElement) => renderToStaticMarkup(el);
const NOW = Date.parse("2026-11-10T10:00:00.000Z");
const QR = renderQrSvg("2@thisisnotarealcode,thisisnotarealcode,thisisnotarealcode");

function view(over: Partial<WhatsAppWebView> = {}): WhatsAppWebView {
  return {
    enabled: true,
    fake: false,
    status: "not-linked",
    phoneMasked: null,
    deviceLabel: null,
    qrSvg: null,
    qrExpiresAt: null,
    consentAt: null,
    consentVersion: CONSENT_VERSION,
    riskText: RISK_TEXT,
    dailyCap: 40,
    sentToday: 0,
    lastError: null,
    suspendedReason: null,
    officialConnected: false,
    ...over,
  };
}

function panelProps(v: WhatsAppWebView, over: Partial<import("../web/src/components/app/WhatsAppQrLink").WhatsAppQrPanelProps> = {}) {
  return {
    view: v,
    starting: false,
    now: NOW,
    consent: false,
    onConsent: () => {},
    busy: null,
    error: null,
    notice: null,
    refreshFailed: false,
    confirmDisconnect: false,
    onConfirmDisconnect: () => {},
    onStart: () => {},
    onCancel: () => {},
    onDisconnect: () => {},
    onTest: () => {},
    ...over,
  };
}
const panel = (v: WhatsAppWebView, over = {}) => render(createElement(qr.WhatsAppQrPanel, panelProps(v, over)));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))?.[0] ?? null;

/* ---------- polling, countdown and the other pure rules ---------- */

test("polling: every 2 s while waiting for a scan or for the first code, slowly while reconnecting, never otherwise or in a hidden tab", () => {
  const delay = (status: WhatsAppWebStatus | null, o: { starting?: boolean; hidden?: boolean; failures?: number } = {}) =>
    ui.pollDelayMs({ status, starting: o.starting ?? false, hidden: o.hidden ?? false, failures: o.failures ?? 0 });
  assert.equal(ui.QR_POLL_MS, 2000);
  assert.equal(delay("waiting-for-scan"), 2000);
  assert.equal(delay("not-linked", { starting: true }), 2000, "pressed start, the worker has not published the first code yet");
  assert.equal(delay("reconnecting"), ui.RECONNECT_POLL_MS);
  for (const s of ["not-linked", "linked", "suspended", "logged-out"] as const) assert.equal(delay(s), null, `${s}: no polling`);
  assert.equal(delay(null), null);
  assert.equal(delay("waiting-for-scan", { hidden: true }), null, "a hidden tab does not poll");
  assert.equal(delay("reconnecting", { hidden: true }), null);
  // Failures (a rate limit, an outage) double the wait up to 30 s; success resets them.
  assert.deepEqual([0, 1, 2, 3, 4, 8, 50].map((failures) => delay("waiting-for-scan", { failures })), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("starting: only while the status is still not-linked, nothing went wrong, and the wait has not run out", () => {
  const nl = { status: "not-linked" as const, lastError: null };
  assert.equal(ui.isStarting(null, nl, NOW), false, "start was never pressed");
  assert.equal(ui.isStarting(NOW - 1000, nl, NOW), true);
  assert.equal(ui.isStarting(NOW - ui.STARTING_TIMEOUT_MS, nl, NOW), false, "gave up waiting");
  assert.equal(ui.isStarting(NOW - 1000, { status: "waiting-for-scan", lastError: null }, NOW), false, "the code arrived");
  assert.equal(ui.isStarting(NOW - 1000, { status: "not-linked", lastError: { code: "worker-not-running", text: "x" } }, NOW), false, "an error ends the wait");
  assert.equal(ui.isStarting(NOW - 1000, null, NOW), false);
});

test("countdown: whole seconds to the expiry, never negative, null without a valid time", () => {
  assert.equal(ui.secondsLeft(new Date(NOW + 19_200).toISOString(), NOW), 20);
  assert.equal(ui.secondsLeft(new Date(NOW - 5000).toISOString(), NOW), 0);
  assert.equal(ui.secondsLeft(null, NOW), null);
  assert.equal(ui.secondsLeft("not a date", NOW), null);
  assert.equal(ui.formatCountdown(7), "0:07");
  assert.equal(ui.formatCountdown(75), "1:15");
  assert.equal(ui.formatCountdown(-3), "0:00");
});

test("the start request carries the consent and the version the server showed, and does not exist without the consent", () => {
  assert.equal(ui.startRequest({ consentVersion: "v-test" }, false), null);
  assert.deepEqual(ui.startRequest({ consentVersion: "v-test" }, true), { action: "start", consent: true, consentVersion: "v-test" });
  assert.equal(ui.canStartLink(false, false), false);
  assert.equal(ui.canStartLink(true, true), false, "not while another request runs");
  assert.equal(ui.canStartLink(true, false), true);
});

test("focus moves to the panel heading only when focus is inside the panel or nowhere", () => {
  assert.equal(ui.shouldMoveFocus(true, false), true);
  assert.equal(ui.shouldMoveFocus(false, true), true);
  assert.equal(ui.shouldMoveFocus(false, false), false, "somebody is typing elsewhere");
});

test("isWhatsAppWebView tells a view from a refusal", () => {
  assert.equal(ui.isWhatsAppWebView(view()), true);
  assert.equal(ui.isWhatsAppWebView({ error: "Too many requests." }), false);
  assert.equal(ui.isWhatsAppWebView(null), false);
  assert.equal(ui.isWhatsAppWebView({ ...view(), status: undefined }), false);
});

/* ---------- the QR image is never markup ---------- */

test("the server's real QR SVG is accepted and becomes a data: URL for an <img>", () => {
  const src = ui.safeQrImageSrc(QR);
  assert.ok(src && src.startsWith("data:image/svg+xml;charset=utf-8,"), "a data URL");
  const decoded = decodeURIComponent(src.slice(src.indexOf(",") + 1));
  assert.equal(decoded, QR.trim());
});

test("a hostile SVG string is refused: no script, handler, link, style, foreignObject, entity or extra root", () => {
  const hostile: Array<[string, string]> = [
    ["script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["onload handler", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>'],
    ["handler on a child", '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="1" height="1"/></svg>'],
    ["foreignObject", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>'],
    ["image with a javascript URL", '<svg xmlns="http://www.w3.org/2000/svg"><image href="javascript:alert(1)"/></svg>'],
    ["anchor", '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example"><rect width="1" height="1"/></a></svg>'],
    ["use with xlink", '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/x.svg#a"/></svg>'],
    ["style attribute", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/a)" width="1" height="1"/></svg>'],
    ["url() in a fill", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/a)" width="1" height="1"/></svg>'],
    ["style element", '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style></svg>'],
    ["CDATA", '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<script>alert(1)</script>]]></svg>'],
    ["comment", '<svg xmlns="http://www.w3.org/2000/svg"><!-- x --><rect width="1" height="1"/></svg>'],
    ["entity declaration", '<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'],
    ["entity use", '<svg xmlns="http://www.w3.org/2000/svg"><title>&lt;script&gt;</title></svg>'],
    ["text outside title", '<svg xmlns="http://www.w3.org/2000/svg">hello<rect width="1" height="1"/></svg>'],
    ["content after the root", '<svg xmlns="http://www.w3.org/2000/svg"></svg><script>alert(1)</script>'],
    ["not an svg", "<img src=x onerror=alert(1)>"],
    ["html page", "<html><body><script>alert(1)</script></body></html>"],
    ["svg left open", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>'],
    ["unquoted attribute", '<svg xmlns="http://www.w3.org/2000/svg"><rect width=1 height=1/></svg>'],
    ["empty", ""],
    ["way too long", `<svg xmlns="http://www.w3.org/2000/svg"><path d="${"M0,0h1v1z".repeat(30_000)}"/></svg>`],
  ];
  for (const [name, svg] of hostile) assert.equal(ui.safeQrImageSrc(svg), null, name);
  assert.equal(ui.safeQrImageSrc(null), null);
  assert.equal(ui.safeQrImageSrc(undefined), null);
});

test("a hostile qrSvg never reaches the page as markup: the panel shows a notice and no <img>, no script, no handler", () => {
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>';
  const html = panel(view({ status: "waiting-for-scan", qrSvg: evil, qrExpiresAt: new Date(NOW + 20_000).toISOString() }));
  assert.ok(!html.includes("<script"), "no script element");
  assert.ok(!/onload|onerror|alert\(/i.test(html), "none of the hostile text");
  assert.ok(!html.includes("<img"), "no image at all");
  assert.match(text(html), /The code could not be shown/);
});

test("a valid code is shown as an <img> with a data: URL only, and its text is nowhere else on the page", () => {
  const html = panel(view({ status: "waiting-for-scan", qrSvg: QR, qrExpiresAt: new Date(NOW + 20_000).toISOString() }));
  const imgs = html.match(/<img[^>]*>/g) ?? [];
  assert.equal(imgs.length, 1);
  assert.match(imgs[0], /src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.match(imgs[0], /alt="QR code to link WhatsApp/);
  assert.ok(!html.includes("<svg role"), "the SVG markup itself is not in the page");
  assert.ok(!html.includes("thisisnotarealcode"), "the payload text is not in the page");
});

test("the screens never insert HTML from a string and import only types from lib/whatsapp-web", () => {
  for (const file of [
    "web/src/components/app/WhatsAppQrLink.tsx",
    "web/src/components/app/WhatsAppModePicker.tsx",
    "web/src/components/admin/InfluencerWhatsAppWebPanel.tsx",
    "web/src/lib/whatsapp-web-ui.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("dangerouslySetInnerHTML"), `${file}: no dangerouslySetInnerHTML`);
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(source), `${file}: no raw HTML insertion`);
    for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*from\s+"@\/lib\/whatsapp-web[^"]*";/gm)) assert.fail(`${file}: value import from lib/whatsapp-web: ${m[0]}`);
    assert.ok(!/from\s+"(@whiskeysockets|uqr|libsignal)/.test(source), `${file}: no server-only package`);
  }
});

/* ---------- the influencer screen, state by state ---------- */

test("not linked: the risk statement in an alert, an unticked consent box, and Show QR code disabled with the reason given", () => {
  const html = panel(view());
  assert.match(html, /role="status"[^>]*id="wa-qr-live">WhatsApp is not linked by QR code\./);
  assert.ok(text(html).includes(RISK_TEXT), "the server's risk text, whole");
  assert.match(html, /class="alert alert--warning"/);
  assert.match(text(html), /not an official\s+WhatsApp service/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="wa-qr-consent"/);
  assert.ok(!/<input[^>]*id="wa-qr-consent"[^>]*checked/.test(html));
  assert.match(text(html), /I understand the risks\./);
  const b = button(html, "Show QR code");
  assert.ok(b, "the button exists");
  assert.match(b, /disabled/, "disabled until the box is ticked");
  assert.match(b, /aria-describedby="wa-qr-consent-hint"/);
  assert.match(html, /id="wa-qr-consent-hint"[^>]*>Tick the box above to continue\./);
  assert.ok(!html.includes("<img"), "no code yet");
  assert.match(text(html), /Official WhatsApp Business connection \(Meta\): not connected/);
});

test("consent gating: ticking the box enables the button; a running request disables it again", () => {
  const ticked = panel(view(), { consent: true });
  assert.ok(!/disabled/.test(button(ticked, "Show QR code") ?? "disabled"));
  assert.ok(!ticked.includes("wa-qr-consent-hint"), "the hint goes away once ticked");
  assert.match(ticked, /<input[^>]*id="wa-qr-consent"[^>]*checked/);
  const busy = panel(view(), { consent: true, busy: "start" });
  assert.match(button(busy, "Show QR code") ?? "", /disabled/);
  assert.match(button(busy, "Show QR code") ?? "", /aria-busy="true"/);
});

test("an API error is shown next to the button and the button points at it", () => {
  const html = panel(view(), { consent: true, error: "The risk statement changed. Please read it again and confirm." });
  assert.match(html, /<div id="wa-qr-error"><div class="alert alert--danger" role="alert">/);
  assert.match(text(html), /The risk statement changed/);
  assert.match(button(html, "Show QR code") ?? "", /aria-describedby="wa-qr-error"/);
});

test("starting (start sent, no code yet): a waiting area, Cancel, and an announcement; no consent form", () => {
  const html = panel(view(), { starting: true });
  assert.match(html, /id="wa-qr-live">Getting your QR code ready\./);
  assert.match(text(html), /Getting your code ready/);
  assert.ok(button(html, "Cancel"));
  assert.ok(!html.includes("wa-qr-consent"));
  assert.match(html, /Starting/);
});

test("waiting for a scan: the code, the countdown, the numbered steps, the 5-minute note and Cancel", () => {
  const html = panel(view({ status: "waiting-for-scan", qrSvg: QR, qrExpiresAt: new Date(NOW + 17_000).toISOString() }));
  assert.match(html, /id="wa-qr-live">Your QR code is ready\. Scan it with your phone\./);
  assert.match(html, /<ol class="qr-steps">/);
  const t = text(html);
  assert.match(t, /Open WhatsApp on the phone/);
  assert.match(t, /Settings, then Linked devices, then Link a device/);
  assert.match(t, /Point the phone's camera at the code/);
  assert.match(t, /This code refreshes in 0:17/);
  assert.match(t, /nobody scans within 5 minutes/);
  assert.ok(button(html, "Cancel"));
  assert.match(html, /class="qr-frame"/);
  assert.match(t, /Waiting for scan/);
  // After the expiry the page says it is getting a new one (the poll replaces the code).
  assert.match(text(panel(view({ status: "waiting-for-scan", qrSvg: QR, qrExpiresAt: new Date(NOW - 1000).toISOString() }))), /Getting a new code/);
  // No code in the answer yet.
  assert.match(text(panel(view({ status: "waiting-for-scan" }))), /Getting your code ready/);
});

test("linked: masked number, device, sent today of the cap, test message, Disconnect; the confirmation dialog explains the effect", () => {
  const linked = view({ status: "linked", phoneMasked: "+91 ••••••• 210", deviceLabel: "Chrome (Mac OS)", sentToday: 7, dailyCap: 40, officialConnected: true });
  const html = panel(linked);
  const t = text(html);
  assert.match(html, /id="wa-qr-live">WhatsApp is linked\./);
  assert.match(t, /\+91 ••••••• 210/);
  assert.match(t, /Chrome \(Mac OS\)/);
  assert.match(t, /7 of 40 sent today/);
  assert.ok(button(html, "Send a test message to my own number"));
  assert.ok(button(html, "Disconnect"));
  assert.match(t, /still an unofficial link/);
  assert.match(t, /Official WhatsApp Business connection \(Meta\): active/);
  assert.match(t, /sends first/);
  // Confirmation dialog, open.
  const open = text(panel(linked, { confirmDisconnect: true }));
  assert.match(open, /Disconnect this number\?/);
  assert.match(open, /delete the saved login/);
  assert.match(open, /remove the device on your phone/);
  assert.match(open, /official WhatsApp Business connection, or by SMS or e-mail/);
  assert.match(open, /Keep it linked/);
  // While a test message is being sent, the buttons are locked.
  const busy = panel(linked, { busy: "test" });
  assert.match(button(busy, "Send a test message") ?? "", /aria-busy="true"/);
  assert.match(button(busy, "Disconnect") ?? "", /disabled/);
});

test("a test message result and a refresh failure are said, not silent", () => {
  const linked = view({ status: "linked", phoneMasked: "+91 ••••••• 210", sentToday: 1 });
  assert.match(text(panel(linked, { notice: "Test message queued." })), /Test message queued\./);
  assert.match(text(panel(linked, { refreshFailed: true })), /could not refresh the status/);
  assert.match(text(panel(linked, { error: "Could not send the test message." })), /Could not send the test message\./);
});

test("reconnecting: says the link was lost, where messages go meanwhile, and offers Disconnect", () => {
  const html = panel(view({ status: "reconnecting", phoneMasked: "+91 ••••••• 210", sentToday: 3 }));
  const t = text(html);
  assert.match(html, /id="wa-qr-live">The WhatsApp link was lost\. Reconnecting\./);
  assert.match(t, /Reconnecting to WhatsApp/);
  assert.match(t, /Meanwhile messages go by SMS or e-mail\./);
  assert.ok(button(html, "Disconnect"));
  assert.ok(!html.includes("wa-qr-consent"));
  assert.match(text(panel(view({ status: "reconnecting", officialConnected: true }))), /Meanwhile messages go through your official WhatsApp Business connection, or by SMS or e-mail\./);
});

test("suspended: the reason, the fallback, Link again (needs the consent again) and Disconnect", () => {
  const html = panel(view({ status: "suspended", suspendedReason: "WhatsApp refused this number. It was paused to avoid making things worse." }));
  const t = text(html);
  assert.match(t, /Sending from your number is paused/);
  assert.match(t, /WhatsApp refused this number\./);
  assert.match(t, /Meanwhile messages go by SMS or e-mail\./);
  assert.match(button(html, "Link again") ?? "", /disabled/, "the consent is asked for again");
  assert.ok(text(html).includes(RISK_TEXT));
  assert.ok(button(html, "Disconnect and delete the saved login"));
  assert.match(button(panel(view({ status: "suspended", suspendedReason: "x" }), { consent: true }), "Link again") ?? "", /^<button type="button" class="btn btn--primary">/);
});

test("logged out (the phone removed the device): says so, nothing is sent, Link again with the consent", () => {
  const html = panel(view({ status: "logged-out" }));
  const t = text(html);
  assert.match(html, /id="wa-qr-live">The linked device was removed from your phone\./);
  assert.match(t, /The linked device was removed/);
  assert.match(t, /nothing is sent from it any more/);
  assert.match(t, /Meanwhile messages go by SMS or e-mail\./);
  assert.match(button(html, "Link again") ?? "", /disabled/);
  assert.ok(!button(html, "Disconnect"));
});

test("a last error from the server is shown in the states where it helps, and a stale one is not repeated for suspended", () => {
  const err = { code: "worker-not-running", text: "The background worker is not running, so the link cannot start." };
  assert.match(text(panel(view({ lastError: err }))), /The background worker is not running/);
  assert.match(text(panel(view({ status: "linked", phoneMasked: "+91 ••••••• 210", lastError: err }))), /The background worker is not running/);
  const once = text(panel(view({ status: "suspended", suspendedReason: "Paused.", lastError: err }))).split("The background worker is not running").length - 1;
  assert.equal(once, 0);
});

test("test mode: the badge says no real WhatsApp is used, and the code is called a test code", () => {
  const html = panel(view({ fake: true, status: "waiting-for-scan", qrSvg: QR, qrExpiresAt: new Date(NOW + 20_000).toISOString() }));
  assert.match(text(html), /Test mode: no real WhatsApp is used/);
  assert.match(text(html), /This is a test code: it cannot be scanned/);
  assert.ok(!text(panel(view())).includes("Test mode"));
});

test("every state announces itself in the one live region, and the heading can take focus", () => {
  const states: Array<[Partial<WhatsAppWebView>, string]> = [
    [{}, "WhatsApp is not linked by QR code."],
    [{ status: "waiting-for-scan", qrSvg: QR }, "Your QR code is ready. Scan it with your phone."],
    [{ status: "waiting-for-scan" }, "Getting your QR code ready."],
    [{ status: "linked" }, "WhatsApp is linked."],
    [{ status: "reconnecting" }, "The WhatsApp link was lost. Reconnecting."],
    [{ status: "suspended" }, "Sending from the linked WhatsApp number is paused."],
    [{ status: "logged-out" }, "The linked device was removed from your phone. Link it again to use it."],
  ];
  for (const [over, sentence] of states) {
    const v = view(over);
    assert.equal(ui.statusAnnouncement(v, false), sentence);
    const html = panel(v);
    assert.equal(html.match(/role="status" aria-live="polite" id="wa-qr-live"/g)?.length, 1, "exactly one live region of the panel");
    assert.ok(html.includes(`id="wa-qr-live">${sentence}</p>`), `${sentence} is in the live region`);
    assert.match(html, /<h3 id="wa-qr-heading" tabindex="-1"/);
  }
});

test("the screen has no promise of safety and no talk of hiding automation", () => {
  const files = ["web/src/components/app/WhatsAppQrLink.tsx", "web/src/components/app/WhatsAppModePicker.tsx", "web/src/lib/whatsapp-web-ui.ts"];
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n") + RISK_TEXT;
  assert.ok(!/\b(safe from|cannot be banned|can't be banned|won't be banned|will not be banned|undetect|bypass|disguise|anti-?ban|human-?like)/i.test(all));
  assert.match(RISK_TEXT, /may restrict or ban the number/);
});

/* ---------- the mode picker ---------- */

const official = createElement("p", { id: "official" }, "OFFICIAL FORM");
const qrNode = createElement("p", { id: "qr" }, "QR PANEL");

test("flag off or status unknown: only the official form, nothing new on the page", () => {
  for (const v of [null, view({ enabled: false })]) {
    const html = render(createElement(picker.WhatsAppModeLayout, { view: v, mode: "official", onMode: () => {}, qr: qrNode, official }));
    assert.equal(html, '<p id="official">OFFICIAL FORM</p>');
  }
  // Even if a QR mode were selected by mistake, with the flag off the official form is what shows.
  assert.equal(render(createElement(picker.WhatsAppModeLayout, { view: view({ enabled: false }), mode: "qr", onMode: () => {}, qr: qrNode, official })), '<p id="official">OFFICIAL FORM</p>');
});

test("flag on: a clear choice, official first and selected by default; picking QR swaps the form for the QR screen", () => {
  const html = render(createElement(picker.WhatsAppModeLayout, { view: view(), mode: "official", onMode: () => {}, qr: qrNode, official }));
  const t = text(html);
  assert.match(t, /How should WhatsApp messages be sent\?/);
  assert.match(t, /Official WhatsApp Business API \(Meta\)/);
  assert.match(t, /Link with QR code \(unofficial\)/);
  assert.match(t, /the safer option/);
  assert.match(t, /terms do not allow this and the number can be restricted or banned without notice/);
  assert.match(html, /<input[^>]*type="radio"[^>]*checked=""[^>]*value="official"/);
  assert.ok(html.includes("OFFICIAL FORM") && !html.includes("QR PANEL"));
  const qrMode = render(createElement(picker.WhatsAppModeLayout, { view: view(), mode: "qr", onMode: () => {}, qr: qrNode, official }));
  assert.ok(qrMode.includes("QR PANEL") && !qrMode.includes("OFFICIAL FORM"));
  assert.match(qrMode, /<input[^>]*type="radio"[^>]*checked=""[^>]*value="qr"/);
  assert.match(html, /<fieldset class="qr-modes"><legend>/, "a labelled group of radios");
});

test("the real picker renders only the official form before the endpoint has answered (and on the server)", () => {
  const html = render(createElement(picker.WhatsAppModePicker, { connection: null, embedded: null }));
  assert.ok(!/QR|qr-modes|wa-mode/.test(html), "nothing of the QR mode");
  assert.match(text(html), /Connect my WhatsApp number/);
});

test("Settings uses the picker in place of the bare official form; onboarding is unchanged", () => {
  const settings = readFileSync("web/src/components/views/dashboard/SettingsView.tsx", "utf8");
  assert.match(settings, /<WhatsAppModePicker connection=\{data\.whatsapp\}/);
  assert.ok(!settings.includes("<WhatsAppConnect"));
  assert.match(readFileSync("web/src/components/app/OnboardingWizard.tsx", "utf8"), /<WhatsAppConnect connection=/);
});

/* ---------- the administrator's card ---------- */

function adminView(over: Partial<import("../web/src/components/admin/InfluencerWhatsAppWebPanel").AdminWhatsAppWebPanelView> = {}) {
  return {
    enabled: true,
    status: "linked" as WhatsAppWebStatus,
    phoneMasked: "+91 ••••••• 210",
    lastConnectedAt: "2026-11-09T08:30:00.000Z",
    sentToday: 4,
    dailyCap: 40,
    sentTotal: 311,
    lastError: null,
    suspendedReason: null,
    ...over,
  };
}
const adminBody = (v = adminView()) => render(createElement(admin.WhatsAppWebPanelBody, { view: v, onDisconnect: () => {} }));

test("admin card: status, masked phone, last connected, sent today / cap / total, last error, and Force disconnect", () => {
  const html = adminBody();
  const t = text(html);
  assert.match(t, /Linked/);
  assert.match(t, /Unofficial/);
  assert.match(t, /\+91 ••••••• 210/);
  assert.match(t, /Last connected\s+9 Nov 2026|Last connected\s+Nov 9, 2026/);
  assert.match(t, /Sent today\s+4 of 40/);
  assert.match(t, /Sent in total\s+311/);
  assert.match(t, /Last error\s+None/);
  assert.ok(button(html, "Force disconnect"));
  const bad = text(adminBody(adminView({ lastError: { code: "send-failed", text: "Three sends in a row failed." } })));
  assert.match(bad, /Three sends in a row failed\./);
});

test("admin card: suspended shows the reason; not linked and logged out have nothing to disconnect", () => {
  const suspended = adminBody(adminView({ status: "suspended", suspendedReason: "WhatsApp refused this number." }));
  assert.match(text(suspended), /Suspended because\s+WhatsApp refused this number\./);
  assert.ok(button(suspended, "Force disconnect"));
  const none = adminBody(adminView({ status: "not-linked", phoneMasked: null, lastConnectedAt: null, sentTotal: 0 }));
  assert.match(text(none), /Not linked/);
  assert.match(text(none), /Last connected\s+Never/);
  assert.ok(!button(none, "Force disconnect"));
  assert.ok(!button(adminBody(adminView({ status: "logged-out" })), "Force disconnect"));
  for (const s of ["waiting-for-scan", "linked", "reconnecting", "suspended"] as const) assert.equal(admin.canForceDisconnect(s), true, s);
  for (const s of ["not-linked", "logged-out"] as const) assert.equal(admin.canForceDisconnect(s), false, s);
});

test("admin card: hidden entirely when the platform flag is off, and when the answer has not arrived", () => {
  // The panel draws nothing without data (a static render has none) and, with data, nothing when `enabled` is false.
  const client = new rq.QueryClient({ defaultOptions: { queries: { retry: false } } });
  const card = () => render(createElement(rq.QueryClientProvider, { client }, createElement(admin.InfluencerWhatsAppWebPanel, { influencerId: "inf_1" })));
  assert.equal(card(), "", "no answer yet: nothing, not even an empty card");
  client.setQueryData(queryKeys.admin("influencer-whatsapp-web", { id: "inf_1" }), adminView({ enabled: false }));
  assert.equal(card(), "", "platform flag off: nothing");
  client.setQueryData(queryKeys.admin("influencer-whatsapp-web", { id: "inf_1" }), adminView());
  assert.match(text(card()), /WhatsApp by QR code/);
  assert.ok(button(card(), "Force disconnect"));
  const source = readFileSync("web/src/components/admin/InfluencerWhatsAppWebPanel.tsx", "utf8");
  assert.match(source, /if \(!view\.enabled\) return null;/);
  assert.match(source, /query\.data === undefined/);
  const detail = readFileSync("web/src/components/views/admin/InfluencerDetailView.tsx", "utf8");
  assert.equal(detail.match(/<InfluencerWhatsAppWebPanel influencerId=\{i\.id\} \/>/g)?.length, 1, "mounted once");
});

test("force disconnect needs a reason of 5 to 300 characters once trimmed", () => {
  assert.match(ui.disconnectReasonError("") ?? "", /at least 5/);
  assert.match(ui.disconnectReasonError("    abc  ") ?? "", /at least 5/);
  assert.equal(ui.disconnectReasonError("12345"), null);
  assert.equal(ui.disconnectReasonError("  12345  "), null);
  assert.equal(ui.disconnectReasonError("x".repeat(300)), null);
  assert.match(ui.disconnectReasonError("x".repeat(301)) ?? "", /300 characters or fewer/);
});

test("the reason form: required field, nothing wrong shown before the first try, the error linked to the field after", () => {
  const props = { reason: "", onReason: () => {}, attempted: false, error: null, busy: false, onCancel: () => {}, onSubmit: () => {} };
  const fresh = render(createElement(admin.ForceDisconnectForm, props));
  assert.match(fresh, /<textarea[^>]*id="wa-web-reason"[^>]*required/);
  assert.ok(!fresh.includes("aria-invalid"), "no error before the first try");
  assert.match(text(fresh), /5 to 300 characters\./);
  const tried = render(createElement(admin.ForceDisconnectForm, { ...props, attempted: true, reason: "abc" }));
  assert.match(tried, /aria-invalid="true"/);
  assert.match(tried, /aria-describedby="wa-web-reason-error"/);
  assert.match(tried, /id="wa-web-reason-error" role="alert"/);
  assert.match(text(tried), /Write a reason of at least 5 characters\./);
  const refused = render(createElement(admin.ForceDisconnectForm, { ...props, reason: "valid reason", attempted: true, error: "This number is not linked." }));
  assert.ok(!refused.includes("aria-invalid"));
  assert.match(text(refused), /This number is not linked\./);
  assert.match(render(createElement(admin.ForceDisconnectForm, { ...props, busy: true })), /disabled=""[^>]*>Back/);
});

/* ---------- copy elsewhere ---------- */

test("the Privacy page says what QR linking stores and what it does not read", async () => {
  const { PrivacyView } = await import("../web/src/components/views/public/PrivacyView");
  const t = text(render(createElement(PrivacyView)));
  assert.match(t, /WhatsApp linked by QR code \(optional\)/);
  assert.match(t, /encrypted login for the linked device/);
  assert.match(t, /linked phone number/);
  assert.match(t, /counts of messages sent/);
  assert.match(t, /only about a booking that a customer made/);
  assert.match(t, /do not read or store customers.{1,3}replies/);
  assert.match(t, /host disconnects, we delete the stored login/);
  assert.match(t, /unofficial method and WhatsApp may restrict or ban the number/);
});
