import { META_APP_ID, META_ES_CONFIG_ID } from "./fixtures";
import { HttpError, isLocalUrl, randomHex, requireSameOrigin, type Ctx, type Router, type Runtime } from "./http";
import { createWaba, mintEsCode } from "./meta";
import { esc, renderPlainPage } from "./ui";

/**
 * The mock of Meta's Embedded Signup: a stand-in for the Facebook JS SDK (served as /meta/en_US/sdk.js, which the app's own
 * WhatsAppConnect component loads when the server offers it) and the sign-up window it opens. The component, its state machine and
 * the server-side connect path are the real ones; only the script and the window are fake.
 *
 * HONEST LIMIT: the popup sends the message shape THIS APP expects (web/src/components/app/WhatsAppConnect.tsx). Meta's real dialog, its
 * steps and its real message format and timing have NOT been verified. The SDK delivers the popup's answer as a synthetic window
 * message with origin https://www.facebook.com, which passes the component's origin check by construction.
 */

const SESSION = /^[A-Za-z0-9_-]{6,64}$/;
const FORM_TTL_MS = 30 * 60_000;
const CANCEL_STEPS = ["BUSINESS_ACCOUNT_SELECTION", "WABA_SELECTION", "PHONE_NUMBER_SETUP"];

/** Single-use tokens of the sign-up form, per server. */
const forms = new WeakMap<Runtime, Map<string, number>>();
const formTokens = (rt: Runtime) => {
  let m = forms.get(rt);
  if (!m) forms.set(rt, (m = new Map()));
  return m;
};

/** The SDK. The mock origin is baked in at serve time from the server's own configuration, never from the request. */
function sdkSource(origin: string): string {
  return `/* MOCK Facebook SDK (scripts/mock-providers/embedded.ts). Not Meta's. It only opens the mock sign-up window. */
(function () {
  "use strict";
  var MOCK_ORIGIN = ${JSON.stringify(origin)};
  var FAKE_APP_ID = ${JSON.stringify(META_APP_ID)};
  var GAP_MS = 800;
  var config = null;

  function randomId() {
    var a = new Uint8Array(12);
    window.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  window.FB = {
    init: function (o) {
      config = o || {};
      if (String(config.appId) !== FAKE_APP_ID) console.warn("[MOCK Facebook SDK] appId is not the mock's fake app; the sign-up window will refuse it.");
    },
    login: function (cb, opts) {
      opts = opts || {};
      var extras = opts.extras || {};
      var session = randomId();
      var query = new URLSearchParams({
        app_id: String((config && config.appId) || ""),
        config_id: String(opts.config_id || ""),
        response_type: String(opts.response_type || ""),
        opener: window.location.origin,
        session: session,
        v: String((config && config.version) || ""),
        siv: String(extras.sessionInfoVersion || "")
      });
      // Opened synchronously from the click, so the pop-up blocker allows it.
      var popup = window.open(MOCK_ORIGIN + "/meta/dialog/embedded-signup?" + query.toString(), "mock_fb_es", "width=640,height=760");
      var done = false;
      var handled = false;
      var timer = null;

      function cleanup() {
        window.removeEventListener("message", onMessage);
        if (timer) clearInterval(timer);
      }
      function finish(resp) {
        if (done) return;
        done = true;
        cleanup();
        cb(resp);
      }
      function emit(d) {
        // What Meta delivers as a window message: the WA_EMBEDDED_SIGNUP event, from a facebook.com origin.
        window.dispatchEvent(new MessageEvent("message", {
          origin: "https://www.facebook.com",
          data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: d.event, data: d.data, version: "3" })
        }));
      }
      function onMessage(e) {
        if (e.origin !== MOCK_ORIGIN || e.source !== popup) return;
        var d = e.data;
        if (!d || typeof d !== "object" || d.session !== session) return;
        handled = true;
        if (d.event === "FINISH") {
          var resp = { authResponse: { code: d.code }, status: "connected" };
          if (d.order === "ids-first") {
            emit(d);
            setTimeout(function () { finish(resp); }, GAP_MS);
          } else {
            // The usual order: the login code first, the account ids a moment later (the app waits for them).
            finish(resp);
            setTimeout(function () { emit(d); }, GAP_MS);
          }
        } else {
          // CANCEL and ERROR: the event comes before the callback, so the app knows why there is no code.
          emit(d);
          finish({ authResponse: null, status: "unknown" });
        }
      }

      if (!popup) return cb({ authResponse: null, status: "unknown" });
      window.addEventListener("message", onMessage);
      timer = setInterval(function () {
        if (popup.closed && !handled) finish({ authResponse: null, status: "unknown" });
      }, 500);
    }
  };
  if (typeof window.fbAsyncInit === "function") setTimeout(window.fbAsyncInit, 0);
})();
`;
}

function errorPage(c: Ctx, title: string, text: string): void {
  c.sendHtml(400, renderPlainPage({ title: `MOCK Embedded Signup: ${title}`, banner: "MOCK of Meta's WhatsApp Embedded Signup, not Meta.", body: `<h1>${esc(title)}</h1><p>${esc(text)}</p>` }));
}

const BANNER =
  "MOCK of Meta's WhatsApp Embedded Signup. It sends the message shape this app expects (web/src/components/app/WhatsAppConnect.tsx). Meta's real dialog, steps and message format have NOT been verified.";

function phoneState(p: { registered: boolean; pin: string | null }): string {
  return p.registered ? (p.pin ? "registered, has a PIN you may not know" : "registered, no PIN") : "fresh: not registered, no PIN";
}

function dialog(c: Ctx): void {
  const rt = c.rt;
  const q = c.query;
  if (q.get("app_id") !== META_APP_ID) return errorPage(c, "Invalid app", `The app_id in the request (${(q.get("app_id") ?? "").slice(0, 30)}) is not the mock's Meta app. Check META_APP_ID.`);
  if (q.get("config_id") !== META_ES_CONFIG_ID) return errorPage(c, "Invalid configuration", `The config_id in the request (${(q.get("config_id") ?? "").slice(0, 30)}) is not the mock's Embedded Signup configuration. Check META_ES_CONFIG_ID.`);
  if (q.get("response_type") !== "code") return errorPage(c, "Invalid response type", "The login must ask for response_type=code.");
  const opener = q.get("opener") ?? "";
  if (!isLocalUrl(opener)) return errorPage(c, "Refused", "The window that opened this one is not on a local address. The mock only answers local apps.");
  const session = q.get("session") ?? "";
  if (!SESSION.test(session)) return errorPage(c, "Invalid session", "Missing or malformed session id.");

  const token = randomHex(16);
  formTokens(rt).set(token, rt.now() + FORM_TTL_MS);
  const options = Object.values(rt.state.meta.wabas)
    .flatMap((w) => w.phoneIds.map((id) => ({ waba: w, phone: rt.state.meta.phones[id] })))
    .map(({ waba, phone }) => `<option value="${esc(waba.id)}:${esc(phone.id)}">${esc(waba.name)} · ${esc(phone.display)} · ${esc(phoneState(phone))} (account ${esc(waba.id)}, number ${esc(phone.id)})</option>`)
    .join("");

  c.sendHtml(
    200,
    renderPlainPage({
      title: "MOCK Embedded Signup",
      banner: BANNER,
      body: `<h1>MOCK Embedded Signup</h1>
<form method="post" action="/meta/dialog/embedded-signup/finish">
<input type="hidden" name="form_token" value="${esc(token)}"><input type="hidden" name="session" value="${esc(session)}"><input type="hidden" name="opener" value="${esc(opener)}">
<h2>1. Business</h2><p>Mock Business (not Meta)</p>
<h2>2. WhatsApp Business Account and 3. Phone number</h2>
<select name="target" style="max-width:100%">${options}<option value="NEW">Create a new WhatsApp Business account with a fresh number</option></select>
<h2>4. Outcome</h2>
<label style="display:block;margin:4px 0"><input type="radio" name="outcome" value="finish" checked> Finish</label>
<label style="display:block;margin:4px 0"><input type="radio" name="outcome" value="cancel"> Cancel at step
 <select name="cancel_step">${CANCEL_STEPS.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
<label style="display:block;margin:4px 0"><input type="radio" name="outcome" value="error"> Error with message <input name="error_message" value="Something went wrong (mock)" size="34"></label>
<h2>5. Order of the answers</h2>
<label style="display:block;margin:4px 0"><input type="radio" name="order" value="code-first" checked> login code first, account ids 800 ms later (the usual)</label>
<label style="display:block;margin:4px 0"><input type="radio" name="order" value="ids-first"> account ids first, login code 800 ms later</label>
<p style="margin-top:16px"><button>Continue</button></p></form>`,
    }),
  );
}

/** JSON that is safe inside a <script> element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

async function finish(c: Ctx): Promise<void> {
  const rt = c.rt;
  requireSameOrigin(c);
  const form = await c.readForm();
  const tokens = formTokens(rt);
  const token = form.get("form_token") ?? "";
  const expires = tokens.get(token);
  tokens.delete(token); // single use
  if (!expires || expires <= rt.now()) throw new HttpError(403, { error: "This sign-up window expired. Close it and press Connect again." });
  const opener = form.get("opener") ?? "";
  const session = form.get("session") ?? "";
  if (!isLocalUrl(opener) || !SESSION.test(session)) throw new HttpError(400, { error: "Bad opener or session" });

  const outcome = form.get("outcome");
  const order = form.get("order") === "ids-first" ? "ids-first" : "code-first";
  let message: Record<string, unknown>;
  if (outcome === "cancel") {
    const step = CANCEL_STEPS.includes(form.get("cancel_step") ?? "") ? form.get("cancel_step")! : CANCEL_STEPS[0];
    message = { session, event: "CANCEL", data: { current_step: step }, order };
    rt.activity(`Embedded Signup: cancelled at ${step}`, "/__mock/meta");
  } else if (outcome === "error") {
    message = { session, event: "ERROR", data: { error_message: (form.get("error_message") ?? "").slice(0, 200) }, order };
    rt.activity("Embedded Signup: ended with an error", "/__mock/meta");
  } else {
    const target = form.get("target") ?? "";
    let wabaId: string;
    let phoneId: string;
    if (target === "NEW") {
      ({ wabaId, phoneId } = createWaba(rt));
    } else {
      [wabaId, phoneId] = target.split(":");
      if (rt.state.meta.phones[phoneId]?.wabaId !== wabaId) throw new HttpError(400, { error: "Choose an account and number from the list" });
    }
    message = { session, event: "FINISH", data: { waba_id: wabaId, phone_number_id: phoneId }, code: mintEsCode(rt, wabaId, phoneId), order };
    rt.activity(`Embedded Signup: finished with account ${wabaId} and number ${rt.state.meta.phones[phoneId].display}`, "/__mock/meta");
  }

  c.sendHtml(
    200,
    renderPlainPage({
      title: "MOCK Embedded Signup",
      banner: BANNER,
      body: `<h1>Done</h1><p id="note">Sending the answer to the app and closing this window...</p>`,
      script: {
        nonce: c.nonce,
        code: `(function(){var m=${scriptJson(message)};var o=${scriptJson(new URL(opener).origin)};
if(window.opener){window.opener.postMessage(m,o);window.close();}else{document.getElementById("note").textContent="The app window that opened this one is gone. You can close this window.";}})();`,
      },
    }),
  );
}

export function registerEmbedded(router: Router): void {
  router.add("GET", /^\/meta\/en_US\/sdk\.js$/, (c) => c.sendScript(sdkSource(c.rt.origin)));
  router.add("GET", /^\/meta\/dialog\/embedded-signup$/, dialog);
  router.add("POST", /^\/meta\/dialog\/embedded-signup\/finish$/, finish);
}
