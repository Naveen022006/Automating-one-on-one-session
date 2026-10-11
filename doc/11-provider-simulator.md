# Local provider mock for Google and Meta: specification

Branch: `feature/provider-simulator`, cut from `main` (5a2d9ec at the time of writing). One implementer.
Status: the spec only. Nothing in the repository has been changed. All file:line references are to `main` at 5a2d9ec.
Since then the UI moved: `components/**` is `web/src/components/**`, the client files of `app/` are in `web/src/pages/`, and the old Next
pages named below are deleted (doc/12-front-end.md); the references stay as written because they describe that commit.

---

## 0. Summary

Build a **standalone mock server** (`scripts/mock-providers/`, TypeScript, Node `http` + `crypto` only, no new
dependencies). It runs on `127.0.0.1:4010` and implements just enough of Google (OAuth consent, token and revoke, Calendar
events, Gmail send) and Meta (the Graph calls the app makes, a mock Embedded Signup popup and a mock Facebook SDK, and
**signed** webhook deliveries to the app). It also has a local **inbox and control page** (`/__mock`) where the owner can
see every calendar event, Meet link, Gmail message, WhatsApp message, SMS and webhook, and can inject failures.

The production code gets **one** new input, `MOCK_PROVIDERS_URL`, read in **one** module (`lib/provider-endpoints.ts`).
That module returns either the real provider base URLs or the mock's. This is the only change in behaviour: URLs become
data. No `if (mock)` branch is added to any client, job, route or component. The override applies only when **all** of
these hold:

- `NODE_ENV` is unset, `development` or `test`;
- `APP_URL` is a local address;
- the mock URL is a loopback origin;
- no serverless platform marker is set.

Otherwise the override is ignored: in development it prints a loud warning, and in production the process refuses to
start. `npm run dev:mock` starts the mock server and `next dev` (and, only on request, the worker: see 5.3 and 7.3), with the
mock URL and matching **fake** credentials. Those values are passed through the child processes' environment only and are
never written to `.env`.

Verdict on Embedded Signup: a **mock SDK is worth it**. It needs only a server-provided `sdkUrl`, which is a data change.
That is less risky than a dev-only fake button, because a fake button would be a fake branch in a shipped component. It
exercises the real component and the real server-side Embedded Signup path, including the two-step PIN reset logic. The
popup is labelled as a mock: it does **not** prove Meta's real dialog or message format.

Razorpay stays **real test mode** and is out of scope (section 1.5).

---

## 1. Decision and why

### 1.1 What is built

1. **`lib/provider-endpoints.ts`** (new, server-only). It is the single source of every Google and Meta base URL the app
   calls, and the single place where `MOCK_PROVIDERS_URL` is read and guarded.
2. **Call-site edits.** The hard-coded constants in `lib/google.ts`, `lib/gmail.ts` and `lib/whatsapp-graph-version.ts`
   are replaced by calls to that module. `components/app/WhatsAppConnect.tsx` loads the Facebook SDK from a URL that the
   server supplies, accepted only if it is a loopback mock URL.
3. **`lib/env.ts` start-up validation.** In production, a set `MOCK_PROVIDERS_URL` is an error, and so is any variable
   holding a mock placeholder value. In development, the variable gets a loud warning that says whether it is active or
   ignored.
4. **`scripts/mock-providers/`.** The mock server, its inbox and control UI, its persisted fake state and its webhook
   sender.
5. **`scripts/dev-mock.ts`.** The one-command launcher (mock server and `next dev`, with the env overlay; a worker only with
   `--with-worker`, and only against a local Postgres and Redis with no other worker running: 5.3). The refusal rule is the pure
   `scripts/dev-mock-worker.ts`.
6. **Tests.** A guard unit test, call-site inertness tests and a boundary test, contract tests that run the real lib
   clients against the mock, webhook tests that verify with the app's own verifier and parsers, security tests, and two
   database-gated integration tests.

### 1.2 Why this is the least risky way

- **The code that runs in the demo is the code that runs in production.** The demo exercises the same paths:
  - URL building, `fetch`, error-body parsing and error classification (`lib/google.ts:130-163`, `lib/gmail.ts:94-116`,
    `lib/whatsapp-connect.ts:39-63`);
  - the OAuth state and nonce cookie round trip (`app/api/google/connect/route.ts`,
    `app/api/google/callback/route.ts:38-92`);
  - the BullMQ worker (`worker/index.ts`) and `createMeetingForBooking` (`lib/meeting.ts:301-536`);
  - signature verification on the real webhook route (`app/api/webhooks/whatsapp/route.ts:28-66`);
  - the real settings components.

  Only the host they talk to differs.
- **The blast radius of the production change is one function.** If the guard is right, nothing else can activate the
  mock. A boundary test makes sure nobody adds a second entry point later.
- **The mock lives outside the production artefact.** It is a separate process in `scripts/`. It is not an
  `app/api/...` route, and it is excluded from the Docker build context (`.dockerignore`), so no mock code ships.
- **Fake data is unmistakable.** Every token starts with `MOCK-NOT-REAL-`, every Google account is
  `@mock-google.invalid` (`.invalid` is a reserved TLD), and Meet links point to the mock
  (`http://127.0.0.1:4010/meet/...`), never to `meet.google.com`. Section 3.9 explains why.

### 1.3 Alternatives rejected

| Alternative | Why rejected |
|---|---|
| **In-process fake branches** (`if (process.env.FAKE_GOOGLE) return fakeEvent` in `lib/google.ts`, `lib/whatsapp.ts`, ...) | Puts fake code paths into production modules. The demo would skip exactly the code that matters most (HTTP, error parsing and classification, retries), and one forgotten flag ships fake Meet links to real customers. The owner explicitly forbids it. |
| **nock-style test doubles only** (injected `fetch`, as `tests/google-client.test.ts` and `tests/whatsapp-connect.test.ts` already do, about 1,400 lines) | Already in place and good for unit tests, but the owner cannot click through screens. It does not exercise browser redirects, cookies, the callback route, CSRF and nonce, the worker and its queues, the webhook route over HTTP, or the UI. nock itself would be a new dependency, and recording real traffic needs accounts the owner does not have. |
| **ngrok or another tunnel to the real providers** | Needs a Google Cloud project with an OAuth client, a Meta developer account, a business, a WABA and a phone number, and Tech Provider approval for Embedded Signup. None of these exist, and some take days or weeks. It also exposes a dev box to the internet. This is the right **next** step (the real-provider checklist in section 7.5), not a substitute now. |
| **Mock routes inside Next** (`app/api/__mock/...`) | The mock surface would be compiled into the production app. It would also share the app's process, CSP, rate limits and auth, so it would not behave like an external provider. |
| **Third-party mock tools** (WireMock, Mockoon, Prism, MSW) | New dependency or runtime (Java for WireMock). Record/replay tools handle the needed state poorly: single-use OAuth codes, grants and revocation, etags and 412s, tombstones, template review timers, signed webhooks. MSW intercepts in-process, which amounts to a fake branch. |
| **Dev-only fake Embedded Signup button** (a button that skips `FB.login` and posts `connect-embedded` itself) | A fake branch in a shipped client component (`components/app/WhatsAppConnect.tsx`), and it would skip the component's real state machine (`startEmbedded`, `finishEmbedded`, the wait for ids, the CANCEL and ERROR texts, the PIN prompt). Rejected in favour of the mock SDK (section 1.4). |
| **Manual connect only** (no Embedded Signup) | Leaves the most intricate server path untested end to end: `connectEmbedded`, then code exchange, then a register with a generated PIN, then PIN mismatch, then `canReset`, then `resetPin`, then `setTwoStepPin` (`lib/whatsapp-connection.ts:254-304, 422-439`). It is kept as the fallback if the mock SDK cannot load in some browser (section 7.3). |

### 1.4 Embedded Signup: mock SDK, with the minimum production change

How Embedded Signup works today:

- The component injects `https://connect.facebook.net/en_US/sdk.js` (`components/app/WhatsAppConnect.tsx:62`).
- It calls `FB.init` from `fbAsyncInit` (`:56-59`), then `FB.login` with `config_id`, `response_type: "code"` and
  `sessionInfoVersion: "3"` (`:239-244`).
- It accepts `WA_EMBEDDED_SIGNUP` window messages only from `^https://([a-z0-9-]+\.)?facebook\.com$` (`:135`).
- It waits up to 15 s (30 × 500 ms, `:188`) for `FINISH` with `data.waba_id` and `data.phone_number_id` after it has the
  code.

The plan:

- **Production change (data only).** `embeddedSignupConfig()` (`lib/whatsapp-connect.ts:338-342`) adds
  `sdkUrl: "<mock>/meta/en_US/sdk.js"` **only when the guard is active**. The component uses `embedded.sdkUrl` only if it
  matches a strict loopback pattern (new pure helper `lib/facebook-sdk.ts`). Otherwise it uses the real SDK URL. The
  origin check at `:135` is **not** touched.
- **The mock SDK** (`/meta/en_US/sdk.js`, static JavaScript served by the mock):
  - It defines `window.FB.init` and `FB.login` and then calls `window.fbAsyncInit`.
  - `FB.login` opens the mock popup `/meta/dialog/embedded-signup` (synchronously from the click, so the pop-up blocker
    allows it). It then listens for `postMessage` from the mock origin **and** from that popup window.
  - It turns the popup's answer into the two things Meta delivers:
    - a **synthetic** `MessageEvent` dispatched on `window` with `origin: "https://www.facebook.com"` and the
      `WA_EMBEDDED_SIGNUP` JSON;
    - the `FB.login` callback with `{ authResponse: { code } }`.
  - The order is configurable. The default is code first, then FINISH 800 ms later, which exercises the wait loop at
    `:188`. For CANCEL and ERROR, the event fires **before** the callback, so `session.current.failure` is set when
    `finishEmbedded(undefined)` runs (`:183-186`).
- **CSP: no change to `proxy.ts`.** `script-src` has `'nonce-…' 'strict-dynamic'` (`proxy.ts:116`). A script element
  created by nonce-trusted code is allowed whatever its host. The Razorpay script already loads this way (comment at
  `proxy.ts:115`). The popup is a top-level window, so `frame-src` does not apply. The page's
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` (`next.config.ts:10`) keeps `window.opener`, so the popup can
  post back.
- **Honesty.** The popup says, in a banner: "MOCK of Meta's WhatsApp Embedded Signup. It sends the message shape this app
  expects (components/app/WhatsAppConnect.tsx). Meta's real dialog, steps and message format have NOT been verified." It
  proves the app's side only.

### 1.5 Scope boundaries

| Area | In or out | Notes |
|---|---|---|
| Google OAuth (consent, code, refresh, revoke, ID token) | In | `lib/google.ts` |
| Google Calendar events and Meet links | In | `lib/google.ts`, `lib/meeting.ts`, `lib/manage.ts` |
| Gmail send | In | `lib/gmail.ts`, `lib/customer-email.ts` |
| Meta Graph API (WhatsApp) | In | `lib/whatsapp-connect.ts`, `lib/whatsapp.ts` |
| Embedded Signup | In | Via the mock SDK |
| WhatsApp webhooks (template status and message status) | In | Signed, delivered to `<APP_URL>/api/webhooks/whatsapp` |
| SMS fallback | In, **with no code change** | `SMS_PROVIDER=generic` with `SMS_API_URL=<mock>/sms/send` is existing, legitimate config (`lib/sms.ts:87-99`). The mock acts as an SMS sink. |
| Google userinfo endpoint | Out | The app never calls it. The email comes from the ID token (`lib/google.ts:442-453`). |
| Razorpay | Out | It stays real **test mode**. A booking becomes PAID through the worker's existing missed-webhook recovery: orders at least 3 minutes old are polled every 2 minutes (`lib/payment-recovery.ts:16`, `worker/monitoring.ts:13`), well inside the 20-minute payment window (`lib/holds.ts:10`). No new code is needed. A "signed Razorpay webhook" button is deliberately **not** added: the owner has no real payment id to put in it, so it would write a fake id into a real `Payment` row, and later reconciliation and refunds would call Razorpay with it. Razorpay test keys are a prerequisite (section 5.4). A Razorpay mock is a possible follow-up (section 7.6). |
| Platform email (Resend, Postmark) | Out | `EMAIL_PROVIDER=log` keeps printing to the console. Only the Gmail path goes to the mock. |
| MSG91 and Twilio | Out | Their URLs stay hard-coded (`lib/sms.ts:56,75`). |

---

## 2. Production changes: overridable base URLs

### 2.1 Inventory: every provider URL the app calls (grep of `googleapis.com|accounts.google.com|graph.facebook.com|connect.facebook.net` outside `generated/` and `node_modules/`)

| # | File:line | Today | Used at | Change |
|---|---|---|---|---|
| 1 | `lib/google.ts:10` | `AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"` | `:122` (`buildAuthUrl`) | `${googleEndpoints().auth}?${params}` |
| 2 | `lib/google.ts:11` | `TOKEN_URL = "https://oauth2.googleapis.com/token"` | `:209` (refresh), `:409` (`exchangeCode`) | `googleEndpoints().token` |
| 3 | `lib/google.ts:12` | `CALENDAR_URL = "https://www.googleapis.com/calendar/v3"` | `:232, :262, :279, :304, :326, :350, :369, :389` | `googleEndpoints().calendar`, resolved per call (not captured when `createGoogleClient` runs: the module-level singleton `google` at `:400` is created at import time) |
| 4 | `lib/google.ts:458` | literal `https://oauth2.googleapis.com/revoke?token=` | `revokeToken` | `${googleEndpoints().revoke}?token=` |
| 5 | `lib/gmail.ts:15` | `SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"` | `:81` | `googleEndpoints().gmailSend` |
| 6 | `lib/whatsapp-graph-version.ts:20-22` | `graphBase(env)` returns `https://graph.facebook.com/${graphVersion(env)}` | `lib/whatsapp-connect.ts:43` (every Graph call), `lib/whatsapp.ts:53` (send) | **Move** `graphBase` into `lib/provider-endpoints.ts` as `${graphOrigin(env)}/${graphVersion(env)}`. Update the imports at `lib/whatsapp-connect.ts:2`, `lib/whatsapp.ts:4` and `tests/whatsapp-connect.test.ts:13`. Reason: `lib/whatsapp-graph-version.ts` documents that it is "kept free of imports so the settings card in the browser can use it" (`:7`, used by `components/app/WhatsAppConnect.tsx:10`), and it stays import-free. |
| 7 | `components/app/WhatsAppConnect.tsx:62` | `el.src = "https://connect.facebook.net/en_US/sdk.js"` | `loadFacebookSdk` (`:52`), called at `:119` and `:224` | `el.src = src`, where `src = chooseFacebookSdkUrl(embedded?.sdkUrl)` (section 2.6) |
| 8 | `lib/whatsapp-connect.ts:338-342` | `embeddedSignupConfig()` returns `{ appId, configId, graphVersion }` | `app/dashboard/settings/page.tsx:50`, `app/onboarding/page.tsx:66` (passed into `WhatsAppConnect` and `OnboardingWizard`) | Add `...(sdk ? { sdkUrl: sdk } : {})`, where `sdk = mockFacebookSdkUrl(env)`. Spread **conditionally**: the existing `assert.deepEqual` tests at `tests/whatsapp-connect.test.ts:342,355` must keep passing unchanged. |

### 2.2 Matches that are NOT calls (leave them alone)

- **Scope identifiers.** Google requires the exact strings, and the mock accepts the same ones:
  - `lib/google.ts:16` (`GMAIL_SEND_SCOPE`) and `:18` (`CALENDAR_SCOPE`);
  - `lib/google-tokens.ts:172`;
  - `app/admin/(console)/influencers/[id]/page.tsx:85`.
- **CSP host allow-list.** `proxy.ts:116,120,121`: no change (see 1.4).
- **Comments, copy and docs:**
  - `app/api/google/connect/route.ts:63` (comment);
  - `components/site/ProductFragments.tsx:54,62` (marketing copy);
  - `lib/message-templates.ts:220`. This is the example value Meta reviews: it must stay a realistic `meet.google.com`
    link;
  - `.env.example:78`, `lib/whatsapp-graph-version.ts:5`, `README.md:288` and `doc/08-deployment.md:217`.
- **Other providers, out of scope:**
  - `lib/payments.ts:3` (Razorpay);
  - `lib/sms.ts:56,75` (MSG91, Twilio);
  - `lib/email/providers.ts:41,66` (Resend, Postmark);
  - `app/[influencer]/book/BookingFlow.tsx:80` and `app/pay/[token]/PayNow.tsx:28` (`checkout.razorpay.com`).

### 2.3 The environment variable

**One** variable, `MOCK_PROVIDERS_URL`, for example `http://127.0.0.1:4010`. Every mock endpoint is derived from it.
One variable rather than seven per-endpoint overrides means the mock is all or nothing. A half-mocked setup, such as
mock-issued tokens sent to real `googleapis.com` or a real token sent to the mock Calendar, is impossible to configure.

Mock path layout (mirrors the real paths under a provider prefix):

| Real | Mock |
|---|---|
| `https://accounts.google.com/o/oauth2/v2/auth` | `<mock>/google/o/oauth2/v2/auth` |
| `https://oauth2.googleapis.com/token` | `<mock>/google/token` |
| `https://oauth2.googleapis.com/revoke` | `<mock>/google/revoke` |
| `https://www.googleapis.com/calendar/v3` | `<mock>/google/calendar/v3` |
| `https://gmail.googleapis.com/gmail/v1/users/me/messages/send` | `<mock>/google/gmail/v1/users/me/messages/send` |
| `https://graph.facebook.com/<v>` | `<mock>/meta/<v>` |
| `https://connect.facebook.net/en_US/sdk.js` | `<mock>/meta/en_US/sdk.js` |

### 2.4 `lib/provider-endpoints.ts`: contract

Server-only. Its only import is `graphVersion` from `@/lib/whatsapp-graph-version`. **No other file reads
`MOCK_PROVIDERS_URL`**, apart from the validation call in `lib/env.ts`.

```ts
import { graphVersion } from "@/lib/whatsapp-graph-version";

type EnvRecord = Record<string, string | undefined>;

export const REAL_ENDPOINTS = {
  googleAuth: "https://accounts.google.com/o/oauth2/v2/auth",
  googleToken: "https://oauth2.googleapis.com/token",
  googleRevoke: "https://oauth2.googleapis.com/revoke",
  googleCalendar: "https://www.googleapis.com/calendar/v3",
  gmailSend: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  graphOrigin: "https://graph.facebook.com",
} as const;

/** localhost, 127.0.0.1, [::1] or *.localhost, over http(s), no credentials, and not padded with whitespace. */
export function isLocalAppUrl(raw: string | undefined): boolean;
/** http(s)://127.0.0.1|localhost|[::1][:port] with path "/" only, no query, fragment, credentials or padding. */
export function isLoopbackMockUrl(raw: string | undefined): boolean;

export type MockOverride = { active: true; origin: string } | { active: false; problem: string | null };

/** THE guard. Pure: no logging, reads only the record it is given. */
export function mockProvidersOverride(env: EnvRecord = process.env): MockOverride {
  const raw = env.MOCK_PROVIDERS_URL;
  if (raw === undefined || raw === "") return { active: false, problem: null };
  if (!(env.NODE_ENV === undefined || env.NODE_ENV === "" || env.NODE_ENV === "development" || env.NODE_ENV === "test"))
    return { active: false, problem: "is ignored because NODE_ENV is not development or test" };
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT || env.NETLIFY)
    return { active: false, problem: "is ignored on a serverless platform" };
  if (!isLocalAppUrl(env.APP_URL))          // APP_URL must be SET and local; unset does not count as local
    return { active: false, problem: "is ignored because APP_URL is not set to a local address (localhost, 127.0.0.1, [::1], *.localhost)" };
  if (!isLoopbackMockUrl(raw))
    return { active: false, problem: "is ignored: it must be http://127.0.0.1:<port> (or localhost / [::1]) with no path, query or credentials" };
  return { active: true, origin: new URL(raw).origin };
}

export function googleEndpoints(env: EnvRecord = process.env): { auth: string; token: string; revoke: string; calendar: string; gmailSend: string };
export function graphOrigin(env: EnvRecord = process.env): string;      // REAL or `${origin}/meta`
export function graphBase(env: EnvRecord = process.env): string;        // `${graphOrigin(env)}/${graphVersion(env)}`
export function mockFacebookSdkUrl(env: EnvRecord = process.env): string | undefined; // `${origin}/meta/en_US/sdk.js` only when active
```

Notes for the implementer:

- `new URL("http://[::1]:3000").hostname` is `"[::1]"` (brackets kept). Compare against that.
- Fail closed throughout:
  - An unset `APP_URL` does not count as local.
  - `NODE_ENV=staging` is inert.
  - Values are never trimmed. The WHATWG URL parser strips surrounding spaces, so check `raw !== raw.trim()` first.
- Resolve on **every call**. Do not cache: tests inject env records, and the cost is negligible.
- `http://localhost@evil.com` has hostname `evil.com`, so it must be rejected. A test covers it.

### 2.5 Call-site edits (exact)

**`lib/google.ts`**

- Delete `:10-12`.
- `buildAuthUrl` returns `` `${googleEndpoints().auth}?${params}` ``.
- In `createGoogleClient`, add `const cal = () => googleEndpoints().calendar;` and replace each `${CALENDAR_URL}` with
  `${cal()}`.
- `refreshAccessToken` and `exchangeCode` use `googleEndpoints().token`.
- `revokeToken` uses `` `${googleEndpoints().revoke}?token=${encodeURIComponent(token)}` ``.

**`lib/gmail.ts`**

- Delete `:15`.
- `:81` uses `googleEndpoints().gmailSend`.

**`lib/whatsapp-graph-version.ts`**

- Remove `graphBase` (`:19-22`). Keep `DEFAULT_GRAPH_VERSION` and `graphVersion`, and keep the file import-free.

**`lib/whatsapp-connect.ts`**

- `:2` becomes `import { graphVersion } from "@/lib/whatsapp-graph-version"; import { graphBase, mockFacebookSdkUrl } from "@/lib/provider-endpoints";`.
- In `embeddedSignupConfig` (`:338-342`), build the object as today, then
  `const sdkUrl = mockFacebookSdkUrl(env); return sdkUrl ? { ...cfg, sdkUrl } : cfg;`.
- The return type gains `sdkUrl?: string`.

**`lib/whatsapp.ts`**

- `:4` imports `graphBase` from `@/lib/provider-endpoints`.

Nothing else in `lib/`, `app/`, `worker/` or `proxy.ts` changes.

### 2.6 Facebook SDK URL in the browser

New file **`lib/facebook-sdk.ts`**: import-free, client-safe, no `process.env`.

```ts
export const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const MOCK_SDK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/meta\/en_US\/sdk\.js$/;
/** The SDK to load: the server-supplied mock SDK only if it is a loopback mock URL, otherwise Meta's. */
export function chooseFacebookSdkUrl(candidate: string | null | undefined): string {
  return candidate && MOCK_SDK.test(candidate) ? candidate : FACEBOOK_SDK_URL;
}
```

Changes to **`components/app/WhatsAppConnect.tsx`**:

- `:52`: `loadFacebookSdk(appId, version, src)`.
- `:62`: `el.src = src`.
- `:82`: the prop type adds `sdkUrl?: string`.
- Compute `const sdkSrc = chooseFacebookSdkUrl(embedded?.sdkUrl)` and pass it at `:119` and `:224`.
- Add `sdkSrc` to the dependencies at `:129`.

The production server never sends `sdkUrl`, and the browser ignores anything non-loopback, so this is double-guarded.

Coordination: branch `spa/31-dashboard-setup` will build the SPA settings view. It must pass `embeddedSignupConfig()`
through **unchanged**, `sdkUrl` included. The SPA bundle reads only four build-time variables (`web/vite.config.ts:27`),
so the URL can only reach the browser as API data, which is exactly this design.

### 2.7 Start-up validation (`lib/env.ts`)

- Add `"MOCK_PROVIDERS_URL"` to `KNOWN_ENV_VARS` (`:168-188`).
- After step 2b (`:288-292`), add the following. It uses the **raw** `input`, exactly as the runtime reads it:

```ts
if (input.MOCK_PROVIDERS_URL) {
  const mock = mockProvidersOverride(input);
  if (production) errors.push("MOCK_PROVIDERS_URL: must not be set in production (it points Google and Meta calls at a local mock server); remove it");
  else if (!mock.active) warnings.push(`MOCK_PROVIDERS_URL: ${mock.problem}. Google and Meta calls go to the REAL services`);
  else warnings.push("MOCK_PROVIDERS_URL: ACTIVE. Google (OAuth, Calendar, Gmail) and Meta (Graph API, Embedded Signup SDK) are MOCKED by the local mock server; nothing reaches the real services (development only)");
}
if (production) {
  for (const name of KNOWN_ENV_VARS) {
    const v = input[name];
    if (v && (v.includes("MOCK-NOT-REAL") || v.includes("mock-google.invalid"))) errors.push(`${name}: holds a mock-providers placeholder value; set the real value`);
  }
}
```

- The production error is **not** relaxed by `ALLOW_INSECURE_LOCAL_RUN` (`:265-268`). The Docker image always runs in
  production mode, so the mock is never available there, by design.
- Messages never contain values (the module's convention, `:28-29`).
- In production the web process exits through `instrumentation.ts`, then `initEnvOrExit("web")`. The worker exits at
  `worker/index.ts:18-19`.

### 2.8 Unit-test plan for the guard and the call sites

**`tests/provider-endpoints.test.ts`** (pure, no network). Each test saves and restores any `process.env` keys it
touches.

1. **Unset means real.**
   - `googleEndpoints({})` deep-equals the five real URLs.
   - `graphBase({})` is `"https://graph.facebook.com/v26.0"`, and with `WHATSAPP_GRAPH_VERSION: "v27.0"` it is
     `".../v27.0"`.
   - `mockFacebookSdkUrl({})` is `undefined`.
2. **Active.** `{ MOCK_PROVIDERS_URL: "http://127.0.0.1:4010", APP_URL: "http://localhost:3000" }`, with `NODE_ENV` each
   of `undefined`, `"development"` and `"test"`, gives the mock URLs. `graphBase` is
   `"http://127.0.0.1:4010/meta/v26.0"`. The SDK URL is `"http://127.0.0.1:4010/meta/en_US/sdk.js"`. Also allowed:
   `APP_URL` of `http://127.0.0.1:3000`, `http://[::1]:3000` and `http://app.localhost:3000`; mock hosts `localhost` and
   `[::1]`.
3. **Inert in production.** `NODE_ENV: "production"`, with otherwise valid values, gives the real URLs for **every**
   function, including `mockFacebookSdkUrl`, which returns `undefined`. The same holds for `"staging"`, `"prod"`,
   `"Production"`, and for `VERCEL: "1"` or `NETLIFY: "true"`.
4. **Inert with a non-local `APP_URL`.** Each of these gives the real URLs:
   - `https://app.example.com`, `http://192.168.1.5:3000`, `http://0.0.0.0:3000`;
   - `http://localhost.example.com`, `http://127.0.0.1.nip.io:3000`, `http://evil.localhost.com`;
   - `http://localhost@evil.com`, `http://[::2]:3000`;
   - `""`, `undefined`, `"not a url"`, `" http://localhost:3000"` (padded), `"ftp://localhost"`.
5. **Inert with a non-loopback mock URL.** Each of these gives the real URLs:
   - `http://192.168.1.10:4010`, `https://mock.example.com`, `http://127.0.0.1.evil.com:4010`;
   - `http://user:pw@127.0.0.1:4010`, `http://127.0.0.1:4010/x`, `http://127.0.0.1:4010/?a=1`, `http://127.0.0.1:4010#f`;
   - `file:///etc/passwd`, `" http://127.0.0.1:4010"`, `http://app.localhost:4010` (*.localhost is not accepted for the
     mock host).
6. **`chooseFacebookSdkUrl`.** `undefined`, `""`, `https://evil.com/meta/en_US/sdk.js`, `http://127.0.0.1:4010/x.js` and
   `http://127.0.0.1:4010/meta/en_US/sdk.js?x` all give the real URL. The exact mock URL is returned as given.
7. **`embeddedSignupConfig`.** Without the mock it deep-equals today's three keys, as the existing tests at
   `tests/whatsapp-connect.test.ts:342,355,1214` do. With an active env it has `sdkUrl`. In production with the mock URL
   set, there is no `sdkUrl`.
8. **Call sites, with spy `fetch` and env written into `process.env`** (active, then production, then non-local
   `APP_URL`, in turn). This is the "inert in production and with a non-local APP_URL" test at the call-site level, not
   only the resolver:
   - `new URL(buildAuthUrl("s")).origin` and `.pathname`;
   - `createGoogleClient(spy).insertEvent(...)` request URL;
   - `refreshAccessToken`, `exchangeCode(code, spy)`, `revokeToken(t, spy)`;
   - `sendGmail(at, msg, spy)`;
   - `getPhoneNumber("1", "t", spy)` and `sendWhatsApp({..., credentials}, spy)` (with `MESSAGING_DRY_RUN` and
     `WHATSAPP_DISABLED` unset).

   Each URL must start with the mock base only in the active case and with the real host in the other two.

**`tests/env.test.ts`** (add):

- `KNOWN_ENV_VARS` includes `MOCK_PROVIDERS_URL`, and `.env.example` documents it. The existing test at `:175-183`
  enforces the subset rule.
- Production plus `MOCK_PROVIDERS_URL` gives an error starting `MOCK_PROVIDERS_URL:` that does not contain the value,
  including with `ALLOW_INSECURE_LOCAL_RUN=true` and a localhost `APP_URL`.
- Production plus `GOOGLE_CLIENT_SECRET=MOCK-NOT-REAL-x` gives an error for that variable.
- Development, active, gives the "ACTIVE" warning. Development with a non-local `APP_URL` gives the "REAL services"
  warning.
- Development with the variable unset or blank gives no `MOCK_PROVIDERS_URL` line.

**`tests/mock-providers-boundary.test.ts`** (static source scan of production code):

- In `lib/`, `app/`, `components/`, `worker/`, `web/src/`, `proxy.ts` and `instrumentation.ts`, the string
  `MOCK_PROVIDERS_URL` appears only in `lib/provider-endpoints.ts` and `lib/env.ts`. No file imports from `scripts/`.
- In the same set, the patterns `accounts\.google\.com/o/oauth2`, `oauth2\.googleapis\.com`,
  `www\.googleapis\.com/calendar`, `gmail\.googleapis\.com/gmail`, `graph\.facebook\.com` and `connect\.facebook\.net`
  appear only in `lib/provider-endpoints.ts`, `lib/facebook-sdk.ts` and `proxy.ts`. This stops a future hard-coded URL
  from silently bypassing the mock.
- Files under `scripts/mock-providers/` import nothing from `lib/`. Independence: the mock must not share
  parsing or signing code with the app, so the two can catch each other's mistakes. Only `scripts/dev-mock.ts` may
  import `isLocalAppUrl` from `lib/provider-endpoints.ts`.

---

## 3. The mock server

### 3.1 Process and layout

```
scripts/mock-providers/
  index.ts        CLI: guards, then listen 127.0.0.1; --port (default 4010), --app-url, --state <file>, --reset, --print-env
  server.ts       export createMockServer(opts: { port?: number; appUrl: string; stateFile: string; clock?: () => number })
                    -> Promise<{ url: string; controlToken: string; close(): Promise<void>; state(): MockState }>
  fixtures.ts     every FAKE constant (credentials, accounts, WABAs, phones) + mockEnvOverlay(mockUrl, appUrl)
  state.ts        types, load/save (atomic write-then-rename, debounced 200 ms), reset
  http.ts         tiny router, body reader (1 MB JSON/form; 6 MB for Gmail), host + same-origin + control-token checks, request log
  faults.ts       fault registry, latency, "once" faults
  google.ts       consent page, token, revoke, calendar
  gmail.ts        Gmail send + minimal MIME decoder (headers, multipart/alternative, base64, RFC 2047 words)
  meta.ts         Graph routes, template review timers, message status timelines
  embedded.ts     Embedded Signup popup page + sdk.js (static JS with the mock origin baked in at serve time)
  webhooks.ts     signer + per-target serial delivery queue with retries
  sms.ts          generic SMS sink
  ui.ts           /__mock pages (overview/activity, google, gmail, meta, whatsapp, sms, webhooks, requests, faults), /meet/:code; one esc() for ALL output
scripts/dev-mock.ts  launcher (section 5.3)
```

The state file lives at `os.tmpdir()/session-automation-mock-providers-<user id>/state.json`, outside the repository so it can
never be committed. Every credential and account in it is fake, **but it also holds what the demo made with them: the
customer names, email addresses, phone numbers and message bodies typed into the booking form**. So the directory is per user
(mode 0700, the file 0600 where the OS has modes), a directory owned by someone else or a symlink in its place is refused, and
on Windows the temp directory is already per user. `--reset` deletes it. After a reset, every token the app stored is unknown
to the mock. The app then sees `invalid_grant` or Meta error 190 and shows its real reconnect states, which is the
correct behaviour.

### 3.2 Route overview

```
Google  GET  /google/o/oauth2/v2/auth                    consent page (HTML)
        POST /google/o/oauth2/v2/auth/decision           Allow / Cancel (form) -> 302 to redirect_uri
        POST /google/token                               authorization_code | refresh_token
        POST /google/revoke?token=
        POST /google/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all
        GET|PATCH|DELETE /google/calendar/v3/calendars/primary/events/:id
        POST /google/gmail/v1/users/me/messages/send
Meta    GET  /meta/:v/debug_token?input_token=
        GET  /meta/:v/oauth/access_token?client_id&client_secret&code
        GET  /meta/:v/:phoneNumberId?fields=...           POST /meta/:v/:phoneNumberId   {pin}
        POST /meta/:v/:phoneNumberId/register             POST /meta/:v/:phoneNumberId/messages
        GET  /meta/:v/:wabaId/phone_numbers               GET|POST /meta/:v/:wabaId/message_templates
        GET|POST /meta/:v/:wabaId/subscribed_apps
        GET  /meta/en_US/sdk.js                            GET /meta/dialog/embedded-signup   POST .../finish
SMS     POST /sms/send
UI      GET  /__mock[/<tab>]   GET /__mock/state.json   GET /meet/:code   POST /__mock/<action> (control API, 3.8)
```

`:v` must match `^v\d+\.\d+$`. Any version is accepted and logged (see 7.2). Match `debug_token` and `oauth` before `:id`.

### 3.3 Google: the shapes the app depends on

Every error body uses Google's two formats, which `readError` parses (`lib/google.ts:130-145`):

- OAuth endpoints: `{ "error": "<code>", "error_description": "..." }`;
- APIs: `{ "error": { "code": N, "message": "...", "status": "...", "errors": [{ "reason": "...", "domain": "global", "message": "..." }] } }`.

**Consent page.** `GET /google/o/oauth2/v2/auth`, built by `buildAuthUrl` (`lib/google.ts:107-123`).

- Query parameters: `client_id`, `redirect_uri`, `response_type=code`, `scope`, `include_granted_scopes`, `login_hint?`,
  `access_type=offline`, `prompt=consent`, `state`.
- Validation:
  - `client_id` must equal `fixtures.GOOGLE_CLIENT_ID`. Otherwise show an error page "Error 401: invalid_client". Do not
    redirect; Google does not.
  - `redirect_uri` must be registered. The registered list is `[<appUrl>/api/google/callback]`. Otherwise show an error
    page "Error 400: redirect_uri_mismatch". This catches a wrong `GOOGLE_REDIRECT_URI` the same way Google would.
  - `response_type` must be `code`.
- Page content:
  - A red banner: "MOCK GOOGLE — not Google. Nothing on this page talks to Google."
  - An account chooser with `creator@mock-google.invalid` (default), `second-account@mock-google.invalid`, and "another
    `@mock-google.invalid` address". `login_hint` preselects an account only if it is one of these; otherwise it is shown
    as "hint: <value> (not a mock account)".
  - One checkbox per requested non-identity scope (`calendar.events`, `gmail.send`), all ticked. This mirrors Google's
    granular consent and lets the owner untick either one.
  - A per-request single-use `decisionId` in a hidden field.
- **Allow** (`POST .../decision`, same-origin and `decisionId` checked): mint a code (single-use, 10-minute expiry,
  bound to client, `redirect_uri`, account, granted scopes and `access_type`). Respond 302 to
  `redirect_uri?code=…&state=…&scope=<granted>`.
- **Cancel**: respond 302 to `redirect_uri?error=access_denied&state=…`. The callback maps this to `denied`
  (`app/api/google/callback/route.ts:49`).
- **No auto-allow switch.** `/api/google/connect` is a GET a malicious page could navigate to; an auto-allow would let it
  attach a mock account without a click.
- The page CSP is `form-action 'self' <app origin>`. Chrome applies `form-action` to the 302 that follows the POST.

**Token endpoint.** `POST /google/token`, form-encoded.

- `grant_type=authorization_code` (`exchangeCode`, `lib/google.ts:403-435`, reads `refresh_token`, `scope` and
  `id_token`):
  - Check `client_id` and `client_secret`. If wrong, return 401
    `{"error":"invalid_client","error_description":"The OAuth client was not found."}`.
  - Check the code: unknown, used, expired or `redirect_uri` differs returns 400
    `{"error":"invalid_grant","error_description":"Bad Request"}`.
  - Success returns 200:
    ```json
    { "access_token": "MOCK-NOT-REAL-gat-<hex>", "expires_in": 3599, "token_type": "Bearer",
      "refresh_token": "MOCK-NOT-REAL-grt-<hex>",          // ONLY when access_type=offline
      "scope": "<space-separated granted scopes>",          // union with earlier grants of this client+account (include_granted_scopes)
      "id_token": "<header>.<payload>.<sig>" }
    ```
  - `scope` expands `email` to `https://www.googleapis.com/auth/userinfo.email` and keeps `openid`, as Google reports
    them. The app only checks `CALENDAR_SCOPE` and `GMAIL_SEND_SCOPE` membership (`callback/route.ts:63,77`).
  - `id_token`: header `{"alg":"none","typ":"JWT","kid":"mock-providers"}`; payload
    `{"iss":"<mock>/google","aud":"<client_id>","sub":"<stable id>","email":"<account>","email_verified":true,"iat":…,"exp":…}`;
    signature segment `base64url("MOCK-NOT-REAL")`. The app decodes the payload without verifying it
    (`lib/google.ts:442-453`), by design.
  - A new refresh token is issued on each consent (`prompt=consent`). Earlier refresh tokens of the same grant stay
    valid until the grant is revoked.
- `grant_type=refresh_token` (`refreshAccessToken`, `:208-229`, reads `access_token` only):
  - Check the client, the token and the grant.
  - A revoked grant or unknown token returns 400
    `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`. The app then raises
    `GoogleReconnectError`.
  - Success returns 200 `{access_token, expires_in: 3599, scope, token_type: "Bearer"}`.
  - Access tokens last 1 hour.

**Revoke.** `POST /google/revoke?token=` (`revokeToken`, `:456-466`, ignores the response).

- Revoking an access token or a refresh token revokes the **whole grant** (client plus account): every token of that
  account dies. This mirrors what the app relies on (`googleAccountSharedWithOthers`, `lib/google-tokens.ts:113-117`;
  README "Google's revoke ends the app's access for the whole Google account").
- Returns 200 `{}`, or 400 `{"error":"invalid_token","error_description":"Token expired or revoked"}` when unknown.

**Calendar.** Bearer access token required, on the account of the token's grant (`calendars/primary` is that account's
calendar). Auth errors:

- Missing, unknown, expired or revoked token: 401
  `{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED","errors":[{"reason":"authError"}]}}`,
  which becomes `GoogleReconnectError` (`classifyCalendarError`, `:151-163`).
- Grant lacks `calendar.events`: 403
  `{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED","errors":[{"reason":"insufficientPermissions"}]}}`,
  which also becomes `GoogleReconnectError`.

Event JSON returned by every success (`RawEvent`, `:165-176`). The app reads `id`, `etag`, `status`, `hangoutLink`,
`attendees[].email/displayName`, `conferenceData.createRequest.status.statusCode` and
`conferenceData.entryPoints[type=video].uri` (`toCalendarEvent`, `:186-196`).

```json
{ "kind": "calendar#event", "id": "<id>", "etag": "\"<n>\"", "status": "confirmed|cancelled",
  "htmlLink": "<mock>/__mock/google#event-<id>", "created": "...", "updated": "...", "summary": "...", "description": "...",
  "creator": {"email": "<acct>"}, "organizer": {"email": "<acct>", "self": true},
  "start": {"dateTime": "...", "timeZone": "UTC"}, "end": {...}, "sequence": 0,
  "attendees": [{"email": "...", "displayName": "...", "responseStatus": "needsAction"}],
  "guestsCanInviteOthers": false, "guestsCanModify": false, "reminders": {"useDefault": true},
  "hangoutLink": "<mock>/meet/mock-xxxx-xxxx",                       // absent while pending
  "conferenceData": { "createRequest": {"requestId": "...", "conferenceSolutionKey": {"type": "hangoutsMeet"}, "status": {"statusCode": "success|pending|failure"}},
                      "entryPoints": [{"entryPointType": "video", "uri": "<mock>/meet/mock-xxxx-xxxx", "label": "<mock>/meet/mock-xxxx-xxxx"}],
                      "conferenceSolution": {"key": {"type": "hangoutsMeet"}, "name": "Google Meet (MOCK)"}, "conferenceId": "mock-xxxx-xxxx" } }
```

- **Insert**, `POST …/events?conferenceDataVersion=1&sendUpdates=all` (`:231-259`):
  - The `id` must match `^[a-v0-9]{5,1024}$`. Otherwise return 400 with reason `invalid`, message
    `Invalid resource id value.`.
  - An id that already exists on that calendar, **live, deleted or purged**, returns 409 with reason `duplicate`, message
    `The requested identifier already exists.`. The app maps this to `"exists"` (`:253`). Ids are never reusable, which
    is what `ensureGroupEvent` relies on (`lib/meeting.ts:120-153`).
  - `conferenceData` is honoured only with `conferenceDataVersion=1`.
  - The Meet mode fault decides the result: `instant` gives success; `pending_2s` gives pending, then success on any read
    2 s or more later; `pending_forever`; or `failure`.
  - `sendUpdates=all` appends "Google would email an invite to <attendee>" entries to the invite log (4.4).
- **Get**: a live or tombstoned event returns 200. A tombstone has `status: "cancelled"`, which the app treats as gone
  (`:292`, `lib/meeting.ts:97,147`). A purged event returns 410 with reason `deleted`. A never-existing event returns
  404 with reason `notFound`. The app maps both to `null` (`:265`).
- **Patch** (`:303-310, :325-335, :368-375`): merges `attendees` (replace the list) and/or `start` and `end`.
  - If `If-Match` is present and differs from the current `etag`, return 412
    `{"error":{"code":412,"message":"Precondition Failed","errors":[{"reason":"conditionNotMet"}]}}`. The app re-reads
    and retries (`:311,:376`).
  - Every change bumps `etag`. A time change bumps `sequence`.
  - Patching a missing id returns 404, and a purged one 410. Patching a tombstone returns 200 and keeps
    `status: "cancelled"`. This is an approximation; see 7.2.
  - `sendUpdates=all` logs an invite for added attendees, a cancellation for removed ones, and an update to all on a time
    change.
- **Delete** (`:387-396`): a live event becomes a tombstone (`status: "cancelled"`, `deletedAt`) and returns 204. A
  tombstone or purged event returns 410, which the app treats as success. A never-existing event returns 404.
  `sendUpdates=all` logs cancellations to everyone.
- **Meet link format: `<mock>/meet/mock-<4 chars>-<4 chars>`, never `https://meet.google.com/...`.** A randomly generated
  code in Meet's real `abc-defg-hij` format could be someone's real meeting, and a demo customer clicking it would land in
  a stranger's call. The mock room page says "MOCK Meet room — this is not a real meeting", with the event summary, time
  and attendees. Nothing in the app checks the link's shape. Grep: no `meetLink` validation in `lib/`, `app/`,
  `components/` or `web/src/`.

**Gmail send.** `POST /google/gmail/v1/users/me/messages/send` (`sendGmail`, `lib/gmail.ts:78-117`).

- Body: `{ "raw": base64url(MIME) }`.
- Auth: 401 as for Calendar. A grant without `gmail.send` returns 403 `insufficientPermissions`. The app raises
  `GoogleRequestError` and falls back to the platform sender (`lib/customer-email.ts:88-112`).
- Decode independently of `lib/gmail.ts`: headers up to the first blank line, the `boundary` parameter, each part's
  `Content-Type` plus base64 body, and RFC 2047 `=?UTF-8?B?…?=` words in `From`, `To` and `Subject`.
- Record `{ id, threadId, at, account, from, to, replyTo, subject, text, html, fromRewritten }`. `fromRewritten` is set
  when the `From` address differs from the grant's account.
- Response 200: `{ "id": "<16 hex>", "threadId": "<16 hex>", "labelIds": ["SENT"] }`. The app stores it as
  `gmail:<id>` (`lib/customer-email.ts:99`). The "Gmail not working" badge is derived from that prefix
  (`lib/google-tokens.ts:129-131`).
- Malformed `raw` returns 400 with reason `invalidArgument`.

### 3.4 Meta: the shapes the app depends on

Every Graph error body is
`{ "error": { "message": "...", "type": "OAuthException", "code": N, "error_subcode": M?, "error_user_title"?: "...", "error_user_msg"?: "...", "fbtrace_id": "MOCK…" } }`.
The app keeps `error_user_msg ?? message`, `code` and `error_subcode` (`lib/whatsapp-connect.ts:52-61`).

**Token checks (Bearer header).** An app token `"<appId>|<appSecret>"` is accepted only for `debug_token`.

| Situation | Response | App behaviour |
|---|---|---|
| Unknown token | 400, code 190, "Invalid OAuth access token - Cannot parse access token" | `invalidToken` (`:24-26`) |
| Revoked token | 400, code 190, subcode 460 | `invalidToken` |
| Expired token | 400, code 190, subcode 463 | `invalidToken` |
| Token without access to the WABA or number | 400, code 100, subcode 33 ("Unsupported get request. Object with ID '…' does not exist, cannot be loaded due to missing permissions…") | — |
| Token missing a scope a call needs (`whatsapp_business_management` for templates, PIN, register and subscribe; `whatsapp_business_messaging` for messages) | 403, code 10, "(#10) Application does not have permission for this action" | `invalidToken` (code 10) |

**Endpoints:**

| Endpoint | App code | Response the app reads |
|---|---|---|
| `GET /:phone?fields=display_phone_number,verified_name,quality_rating` | `getPhoneNumber` `:73-80` | `{ id, display_phone_number, verified_name, quality_rating }` |
| `GET /:waba/phone_numbers?fields=id&limit=100` | `wabaOwnsNumber` `:83-86` | `{ data: [{ id }] }` |
| `GET /:waba/message_templates?fields=name,language,status,rejected_reason,components&limit=100[&name=][&after=]` | `readTemplates` `:114-129` | `{ data: [{ id, name, language, status, category, rejected_reason, components: [{ type: "BODY", text }] }], paging: { cursors: { before, after }, next? } }`. `next` is present **only** when more pages exist. `after` is an opaque cursor. Pages of `limit`. `name=` filters on an exact name. |
| `POST /:waba/message_templates` with body `{ name, language, category, components: [{ type: "BODY", text, example: { body_text: [[...]] } }] }` | `ensureTemplates` `:184`, `templatePayload` `:147-155` | `{ id, status: "PENDING", category: "UTILITY" }` |
| `GET /debug_token?input_token=` | `debugWith` `:243-259`, `inspectToken` `:273-284` | `{ data: { app_id, type: "SYSTEM_USER", application: "Mock Platform App", is_valid, expires_at (0 = never), scopes: [...], granular_scopes: [{ scope, target_ids: [waba] }] } }` |
| `GET /oauth/access_token?client_id&client_secret&code` | `exchangeEmbeddedCode` `:345-352` | `{ access_token: "MOCK-NOT-REAL-meta-<hex>", token_type: "bearer" }` |
| `POST /:waba/subscribed_apps` then `GET` | `subscribeApp` `:373-385`, `listSubscribedApps` `:355-358` | POST: `{ success: true }`. GET: `{ data: [{ whatsapp_business_api_data: { id: <appId>, name, link } }] }` |
| `POST /:phone` with body `{ pin }` | `setTwoStepPin` `:392-394` | `{ success: true }` |
| `POST /:phone/register` with body `{ messaging_product: "whatsapp", pin }` | `registerNumber` `:400-408` | `{ success: true }` |
| `POST /:phone/messages` with body `{ messaging_product, to, type: "template", template: { name, language: { code }, components: [{ type: "body", parameters: [{ type: "text", text }] }] } }` | `sendWhatsApp` `lib/whatsapp.ts:41-88`, reads `messages[0].id` | `{ messaging_product: "whatsapp", contacts: [{ input, wa_id }], messages: [{ id: "wamid.MOCK-NOT-REAL-<hex>", message_status: "accepted" }] }` |

Validation rules:

- **Templates POST:**
  - The name must match `^[a-z0-9_]{1,512}$`. Otherwise return 400, code 100, `error_user_msg` "Template name can only
    contain lowercase letters, numbers and underscores".
  - A body that starts or ends with a variable returns 400, code 100.
  - The examples count must equal the variable count. Otherwise return 400, code 100.
  - The same name and language on the WABA returns 400, code 100, **subcode 2388024**, `error_user_msg` "There is
    already English content for this template. You can create a new template and try again." The app treats this as
    already existing (`isAlreadyExists`, `:158-160`).
- **`debug_token`:**
  - An app token inspecting a token of **another** app returns 400, code 100, "(#100) The App_id in the input_token did
    not match the Viewing App". The app then lets the token inspect itself (`:276-283`).
  - With the token itself as the access token, the response reports its own data.
  - An invalid input token returns 200 `{ data: { is_valid: false, error: { code: 190, message }, scopes: [] } }`.
- **`oauth/access_token`:** `client_id` and `client_secret` must equal the fake app. The code must be an unused mock
  Embedded Signup code that has not expired (10 minutes). Otherwise return 400, code 100, "Invalid verification code
  format" or "This authorization code has been used".
  - The token returned has `app_id` set to the platform app, both scopes, `wabaIds: [the chosen WABA]`, and never
    expires.
- **`subscribed_apps` POST:** subscribes the token's own `app_id`. A pasted token minted as "the influencer's own app"
  therefore subscribes the **wrong** app, and the app correctly reports "not subscribed" (`:382-384`).
- **register** (per phone state `{ registered, pin, wrongAttempts, lockedUntil }`):
  - If `lockedUntil > now`, return 400, **code 133008**, "Too many two step verification PIN guesses for this phone
    number".
  - If `pin === null`, set the PIN, set `registered = true`, and succeed.
  - If the PIN matches, set `registered = true` and succeed (idempotent).
  - Otherwise increment `wrongAttempts` and return 400, **code 133005**, "Two step verification PIN Mismatch". After 5
    wrong attempts, set `lockedUntil = now + 5 min`.
  - The app's handling is at `:27-34` and `lib/whatsapp-connection.ts:223-304`.
- **set PIN:** sets `pin`, resets `wrongAttempts` and `lockedUntil`, and succeeds. A locked fault applies here too.
- **messages:**
  - The phone must be `registered`. Otherwise return 400, code 133010, "Account not registered".
  - The template (name plus `language.code`) must exist on the phone's WABA:
    - missing: 404, code 132001, "Template name does not exist in the translation";
    - status PAUSED: 400, code 132015;
    - status DISABLED: 400, code 132016;
    - only APPROVED and FLAGGED are sendable, as in `isSendableStatus` (`lib/message-templates.ts:106-108`).
  - The number of body parameters must equal the number of variables in the **submitted body text**. Otherwise return
    400, code 132000, "Number of parameters does not match the expected number of params".
  - A parameter containing a newline or tab, or with 5 or more consecutive spaces, returns 400, code 132018. The app
    sanitises parameters for this (`lib/message-templates.ts:170-177`).
  - `to` must match `^\+?\d{8,15}$`.
  - The mock renders the customer-visible text by substituting `{{n}}` in the stored body and records it.
  - The codes outside those the app depends on (190, 10, 133005, 133008) are approximations. See 7.2.

**Embedded Signup popup.** `GET /meta/dialog/embedded-signup?app_id&config_id&response_type&opener&session&v&siv`.

- Validation: `app_id` must equal `META_APP_ID`, `config_id` must equal `META_ES_CONFIG_ID`, and `response_type` must be
  `code`. If any check fails, show an error page naming the mismatch. `opener` must pass the `isLocalAppUrl` rule;
  otherwise refuse. This rule is re-implemented inside the mock, not imported.
- Steps on one form:
  1. Business: the fake "Mock Business (not Meta)".
  2. WhatsApp Business Account: one of the fixture WABAs, or "create a new one", which creates a WABA and a fresh number.
  3. Phone number: shown with its state (fresh / has a PIN you do not know / registered).
  4. Outcome: **Finish**, **Cancel at step** (select `BUSINESS_ACCOUNT_SELECTION` / `WABA_SELECTION` /
     `PHONE_NUMBER_SETUP`), or **Error** (message field).
  5. Ordering: `code-first` (default) or `ids-first`.
- `POST …/finish` (same-origin plus form token):
  - Mint an Embedded Signup code bound to `{app, waba, phone}`.
  - Return a small HTML page whose nonce'd script runs
    `window.opener.postMessage({ session, event, data: { waba_id, phone_number_id } | { current_step } | { error_message }, code?, order }, <opener origin>)`
    and then `window.close()`.

**`sdk.js`.** Static, except for the mock origin baked in at serve time from server config, never from the request.
Behaviour as in 1.4:

- `init(o)` stores the config and warns in the console if `appId` is not the fake app.
- `login(cb, opts)` opens the popup with `window.open(url, "mock_fb_es", "width=640,height=760")`. If the popup is
  blocked, it calls `cb({ authResponse: null, status: "unknown" })`.
- It accepts a message only if `e.origin === MOCK_ORIGIN && e.source === popup && e.data.session === session`.
- It polls `popup.closed` every 500 ms. If the user closes the popup with no message, it calls
  `cb({ authResponse: null, status: "unknown" })`.
- On FINISH it calls `cb({ authResponse: { code }, status: "connected" })` and dispatches
  `new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event, data, version: "3" }) })`
  on `window`, in the configured order and with the configured gap.
- It ends with `if (typeof window.fbAsyncInit === "function") setTimeout(window.fbAsyncInit, 0)`.
- Serve it with `Content-Type: application/javascript; charset=utf-8` and `Cache-Control: no-store`.

### 3.5 SMS sink

`POST /sms/send`, called by `sendViaGeneric` (`lib/sms.ts:87-99`).

- Requires `Authorization: Bearer <fixtures.SMS_API_KEY>`. Otherwise return 401.
- Body: `{ to, body }`.
- Response: 200 `{ id: "MOCK-SMS-<hex>", messageId: "MOCK-SMS-<hex>" }`.
- Records the message in the outbox.
- Fault `sms`: `ok | 500`.

### 3.6 In-memory state model (persisted to the state file)

```ts
interface MockState {
  version: 1; createdAt: string;
  google: {
    accounts: Record<string /*email*/, { email: string; name: string; sub: string }>;
    pendingDecisions: Record<string, { clientId; redirectUri; state; scopes: string[]; accessType; expiresAt }>;
    codes: Record<string, { clientId; redirectUri; email; scopes: string[]; offline: boolean; expiresAt; used: boolean }>;
    grants: Record<string /*grantId*/, { clientId; email; scopes: string[]; createdAt; revokedAt: string | null }>;   // one live grant per (client, email)
    refreshTokens: Record<string, string /*grantId*/>;
    accessTokens: Record<string, { grantId; expiresAt }>;
    calendars: Record<string /*email*/, Record<string /*eventId*/, MockEvent>>;
    invites: { at; account; eventId; to; kind: "invite" | "update" | "cancel" }[];      // "Google would email ..."
    sentMail: Record<string /*email*/, MockMail[]>;
  };
  meta: {
    wabas: Record<string, { id; name; phoneIds: string[]; subscribedApps: string[]; templates: Record<string, MockTemplate> }>;
    phones: Record<string, { id; wabaId; display; verifiedName; quality: "GREEN"; registered: boolean; pin: string | null; wrongAttempts: number; lockedUntil: string | null }>;
    tokens: Record<string, { appId; type: "SYSTEM_USER"; scopes: string[]; wabaIds: string[]; expiresAt: number | null; revokedAt: string | null; label: string }>;
    esCodes: Record<string, { appId; wabaId; phoneId; used: boolean; expiresAt }>;
    messages: Record<string /*wamid*/, { id; phoneId; to; template; language; params: string[]; rendered: string; at; statuses: { status; at; delivered?: number }[] }>;
  };
  sms: { id; at; to; body }[];
  webhooks: { target: string; log: { id; at; kind; attempt; status: number | null; error: string | null; bodyPreview: string }[] };
  requests: { at; method; path /*secrets redacted*/; status; ms; fault: string | null }[];   // ring buffer 300
  activity: { at; text; link?: string }[];                                                    // ring buffer 500, the story feed
  faults: FaultSettings;
}
```

`MockEvent` holds `{ id, etag, seq, status, summary, description, start, end, attendees, conference: { requestId, status,
code, readyAt }, created, updated, deletedAt, purged, history: string[] }`. `MockTemplate` holds `{ id, name, language,
category, status, rejectedReason, body, examples, createdAt, decideAt: string | null }`.

Seeded fixtures (`fixtures.ts`; every value is fake):

| What | Value |
|---|---|
| Google client | `GOOGLE_CLIENT_ID=mock-client-id.apps.mock-google.invalid`, `GOOGLE_CLIENT_SECRET=MOCK-NOT-REAL-google-client-secret` |
| Google accounts | `creator@mock-google.invalid` ("Mock Creator"), `second-account@mock-google.invalid` |
| Meta app | `META_APP_ID=990000000000001`, `META_APP_SECRET=MOCK-NOT-REAL-meta-app-secret`, `META_ES_CONFIG_ID=990000000000002`, "influencer's own app" id `990000000000009` |
| Webhook verify token | `MOCK-NOT-REAL-verify-token` |
| SMS key | `MOCK-NOT-REAL-sms-key` |
| WABA 990000000001001 "Mock Coaching (new account)" | phones 990000000002001 `+91 00000 02001` **fresh** (not registered, no PIN) and 990000000002002 `+91 00000 02002` **registered with PIN 123456 the app does not know** (shows the `canReset` flow) |
| WABA 990000000001002 "Mock Studio (has an old template)" | phone 990000000002003 **registered, no PIN** (the manual-connect number); a pre-existing APPROVED template `sa_reschedule` with **2** variables (shows `CONFLICT`, `lib/whatsapp-connect.ts:211-218`) |
| WABA 990000000001003 "Mock Big Account" | phone 990000000002004; 150 unrelated APPROVED templates (forces the `paging.next` / `after` cursor path, `:114-129`) |

Ids are digits because the app requires `^\d{5,30}$` (`lib/whatsapp-connection.ts:85`). Tokens deliberately avoid real
prefixes (`ya29.`, `1//`, `EAA`) so they cannot be mistaken for real ones and do not trip secret scanners.

### 3.7 Failure injection

Faults are set from the `/__mock/faults` page or `POST /__mock/faults` `{ key, value, once? }`. `once: true` applies to
the next matching request only.

| Key | Values | What it shows in the app |
|---|---|---|
| `google.refresh` | `ok` / `invalid_grant` / `invalid_client` / `500` | `GoogleReconnectError` and the reconnect-needed state (`lib/meeting.ts:480-489`); transient retry |
| `google.code` | `ok` / `invalid_grant` / `no_refresh_token` | callback outcome `failed`; "did not return a refresh token" (`lib/google.ts:429-433`) |
| `google.calendar` | `ok` / `401` / `403_accessNotConfigured` / `403_insufficientPermissions` / `403_rateLimitExceeded` / `429` / `500` | reconnect, transient (retry then `reportMeetingFailure`) or request-error branches (`lib/google.ts:147-163`) |
| `google.meet` | `instant` (default) / `pending_2s` / `pending_forever` / `failure` | `waitForMeetLink` polling and the transient retry (`lib/meeting.ts:85-107`) |
| `google.patch412` | `once` | the If-Match re-read loop (`lib/google.ts:278-321`) |
| `google.gmail` | `ok` / `401` / `403_accessNotConfigured` / `403_insufficientPermissions` / `429` / `500` | platform fallback, "Gmail not working" badge, reconnect flag (`lib/customer-email.ts:100-109`) |
| `meta.send` | `ok` / `190` / `10` / `500` / `132001` | `markTokenInvalid` then SMS fallback; transient retry |
| `meta.templates` | `ok` / `10` / `500` | the template sync failing (`lastError` "Could not submit") |
| `meta.review` | `auto:<seconds>` (default `auto:15`) / `manual` / `reject:<reason>` | PENDING, then APPROVED or REJECTED |
| `meta.status` | `delivered_read` (default sent +1 s, delivered +3 s, read +8 s) / `sent_only` / `failed_131026` / `instant` / `out_of_order` | Message rows SENT, DELIVERED, READ or FAILED; races (7.4) |
| `meta.webhooks` | `on` / `off` / `bad_signature` / `app_500_once` | the 30-minute sync and "Check template status" paths; 401 on a bad signature; Meta-style retry |
| `meta.pinLock` | per phone: lock / unlock | `pinLocked` (133008) |
| `latency.google` / `latency.meta` / `latency.sms` | `0` / `2000` / `16000` (past Google's 15 s client timeout) / `21000` (past Graph's 20 s) / `reset` (destroy the socket) | transient errors from timeouts and network failures |

Grant and token actions on the control page:

- "Revoke this Google grant" simulates the user removing access at myaccount.google.com.
- "Expire all access tokens".
- "Delete this event behind the app's back" simulates the influencer deleting it in Calendar.
- "Purge deleted events" makes tombstones return 410.
- "Revoke this Meta token" and "Expire this Meta token".
- Per template: "Approve", "Reject", "Pause", "Disable", "Flag", "Reinstate". Each delivers the webhook.

### 3.8 Control API

Every POST requires **both** of these:

- the header `X-Mock-Control: <controlToken>` or a hidden form field `_mock` with that token. The token is random per
  process; the page embeds it, and tests get it from `createMockServer`;
- `Sec-Fetch-Site: same-origin`, or an `Origin` equal to the mock origin, or neither header present (non-browser
  clients).

| Route | Body | Effect |
|---|---|---|
| `POST /__mock/faults` | `{ key, value, once? }` | set a fault |
| `POST /__mock/google/revoke-grant` | `{ grantId }` | revoke the grant |
| `POST /__mock/google/expire-access` | — | expire all access tokens |
| `POST /__mock/google/delete-event` | `{ account, eventId }` | delete behind the app's back |
| `POST /__mock/google/purge` | — | purge deleted events |
| `POST /__mock/meta/mint-token` | `{ app: "platform" \| "own", scopes: string[], wabaIds: string[], expiresInDays: 0 \| 1 \| 30 }` | returns `{ token }`; shown on the page in the "Manual connect kit" |
| `POST /__mock/meta/revoke-token` | `{ token }` | revoke |
| `POST /__mock/meta/template` | `{ wabaId, templateId, action }` | change status and deliver the webhook |
| `POST /__mock/meta/phone` | `{ phoneId, action: "set-pin" \| "clear-pin" \| "lock" \| "unlock", pin? }` | change phone state |
| `POST /__mock/webhooks/verify` | — | runs Meta's GET handshake against the app and shows pass or fail |
| `POST /__mock/webhooks/target` | `{ url }` | must pass the local-address rule |
| `POST /__mock/meta/waba` | none | **for tests only**: makes a new empty account with one fresh number and random ids (what the popup's "create a new account" does) and returns `{ wabaId, phoneId }`, so database tests never reuse the fixed demo ids |
| `POST /__mock/meta/es-code` | `{ wabaId, phoneId }` | **for tests only**: mints an Embedded Signup code without the popup (same code path as `finish`) |
| `POST /__mock/reset` | `{ confirm: "reset" }` | reset state |

`GET /__mock/state.json` returns the whole state for tests and debugging. All of it is fake, but tokens are still
redacted to their last 6 characters unless `?full=1` is passed together with the control token.

### 3.9 Security

- **Network.** `server.listen(port, "127.0.0.1")` only. There is no `--host` flag. Tests assert
  `server.address().address === "127.0.0.1"`.
- **Host header (DNS-rebinding defence).** A request whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or
  `[::1]:<port>` gets 421.
- **Refusal to start (in `index.ts` and in `createMockServer`):**
  - `NODE_ENV=production`;
  - `appUrl` failing the local-address rule (re-implemented in the mock);
  - any of `VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `LAMBDA_TASK_ROOT` or `NETLIFY` set;
  - port in use, with a clear message.
- **No real credentials, ever:**
  - The mock accepts **only** tokens and codes it minted (exact lookup in state). Anything else is rejected with the
    provider's "invalid token" error.
  - A token it did not mint is **never** echoed in a response, written to the request log or printed. The log shows
    `Bearer <unknown token, not logged>`.
  - Query values named `token`, `input_token`, `access_token`, `client_secret` and `code` are redacted in the log.
  - Webhooks and Google redirects go only to local-address targets.
- **Fake values are marked:** the `MOCK-NOT-REAL-` prefix on every secret-like value, the `.invalid` domain, the
  "(MOCK)" / "(not Meta)" names, and Meet links on the mock origin.
- **Pages:**
  - Every page has a CSP: `default-src 'none'; script-src 'nonce-<n>'; style-src 'unsafe-inline'; img-src data:; form-action 'self' <app origin>; frame-ancestors 'none'; base-uri 'none'`.
  - **All** dynamic values pass through one `esc()`. Customer names, email subjects and bodies come from booking input,
    so this matters (stored XSS).
  - Gmail HTML renders only in `<iframe sandbox srcdoc="…">` with no `allow-*` tokens. If a browser's CSP blocks
    srcdoc, the text part is shown instead.
  - `sdk.js` reflects nothing from the request into code.
- **Persistence** goes to a per-user, private directory under `os.tmpdir()` (3.1), never inside the repository. The credentials in it are
  fake; the customer names, emails, phones and messages of the demo's bookings are not, so it is treated as private data.
- **No auto-consent** (3.3). No route serves files from disk.
- **No new dependencies.** Only Node built-ins.

---

## 4. Webhooks, and what the owner sees

### 4.1 Signing

- `body = JSON.stringify(payload)` is computed **once**, and those exact bytes are both signed and sent.
- Header `X-Hub-Signature-256: sha256=<lowercase hex HMAC-SHA256(body, META_APP_SECRET)>`. This is the format
  `verifyMetaSignature` checks (`lib/whatsapp-webhook.ts:15-33`). Also send `X-Hub-Signature: sha1=<hex>`, as Meta does;
  the app ignores it.
- `Content-Type: application/json`, `User-Agent: mock-providers/1`.
- The HMAC is written in the mock; it does **not** import `lib/whatsapp-webhook.ts`. The webhook test then checks the
  mock's signature with the app's verifier, so a mismatch between the two implementations shows up.
- The launcher sets `META_APP_SECRET` **and** `WHATSAPP_APP_SECRET` to the same fake value. `webhookAppSecret` reads
  `WHATSAPP_APP_SECRET` first (`lib/whatsapp-connect.ts:322-324`), so a stale value in `.env` cannot cause a mismatch.

### 4.2 Payloads (exactly what the app's parsers read)

Template status, parsed by `parseTemplateStatusUpdates` (`lib/whatsapp-webhook.ts:131-154`): it reads `entry.id`,
`changes.field`, `value.event`, `message_template_name`, `message_template_language` and `reason`.

```json
{ "object": "whatsapp_business_account",
  "entry": [{ "id": "<wabaId>", "time": 1760000000,
    "changes": [{ "field": "message_template_status_update",
      "value": { "event": "APPROVED", "message_template_id": 123, "message_template_name": "sa_booking_confirmation",
                 "message_template_language": "en", "reason": "NONE" } }] }] }
```

Message status, parsed by `parseWhatsAppStatuses` (`:96-116`): it reads `statuses[].id`, `.status` and
`.errors[0].message|title|code`.

```json
{ "object": "whatsapp_business_account",
  "entry": [{ "id": "<wabaId>",
    "changes": [{ "field": "messages",
      "value": { "messaging_product": "whatsapp",
                 "metadata": { "display_phone_number": "+91 00000 02001", "phone_number_id": "990000000002001" },
                 "statuses": [{ "id": "wamid.MOCK-NOT-REAL-…", "status": "delivered", "timestamp": "1760000003",
                                "recipient_id": "919876543210" }] } }] }] }
```

For `failed`, add `"errors": [{ "code": 131026, "title": "Message undeliverable", "message": "Message undeliverable" }]`.

- **When template deliveries happen:** on a review decision, after `meta.review` seconds or on a control-page action.
- **When status deliveries happen:** after a successful send, per the `meta.status` timeline.
- Only WABAs to which the **platform** app is subscribed get deliveries. This mirrors Meta and makes the "subscribed /
  not subscribed" display meaningful.

### 4.3 Delivery

- Target: `<appUrl>/api/webhooks/whatsapp`, which is changeable on the page but must stay local. The proxy exempts
  webhooks from CSRF (`lib/auth/csrf.ts:12`).
- One serial queue per target, so the default timeline arrives in order. Each POST has a 10 s timeout.
- On a non-2xx response or a network error, retry after 2 s, 10 s and 30 s, then give up and log "dropped". Meta itself
  retries for days (see 7.2).
- Every attempt is logged with its status and the first 200 characters of the response.
- **Verify handshake button.** It sends
  `GET <target>?hub.mode=subscribe&hub.verify_token=<fake>&hub.challenge=<random>` and expects 200 with a body equal to
  the challenge (`app/api/webhooks/whatsapp/route.ts:13-23`). This is the step Meta performs when the webhook is
  configured.

### 4.4 Pages the owner uses

`http://127.0.0.1:4010/__mock`. Every page has a header banner: "MOCK PROVIDERS. Nothing here is Google or Meta. Real
review, delivery and consent behave differently: see 'What this does not prove'."

- **Overview / Activity.** One chronological feed telling the whole story, plus counts and links. Example:
  - "10:42:01 Google: creator@… allowed Calendar + Gmail"
  - "10:45:12 Calendar: event created for '1:1 Career Call with Demo Creator', attendee asha@example.com, link /meet/mock-ab12-cd34"
  - "Google would email an invite to asha@example.com"
  - "Gmail: 'Booking confirmed…' from creator@… to asha@…"
  - "WhatsApp: sa_booking_confirmation to +91… 'Your booking is confirmed. Join link: …'"
  - "Webhook → app: delivered (200)"

  `?live=3` adds a 3-second meta refresh.
- **Google:**
  - accounts and grants (scopes, revoke button);
  - per account, a calendar table: summary, start and end, status, attendees, Meet link, etag and sequence, history, and
    "delete behind the app's back";
  - the invite log ("Google would have emailed").
- **Gmail:** the outbox list, plus a detail view with headers, a `fromRewritten` flag, the text part and the sandboxed
  HTML.
- **Meta:**
  - WABAs, numbers (registered, PIN set yes/no, locked) and subscribed apps;
  - templates with status and action buttons, and a note next to the review timer: "real Meta review: minutes to 24
    hours, may reject or re-categorise";
  - tokens (app, scopes, expiry, revoke);
  - the **Manual connect kit**: copy-able WABA id and phone number id, plus a "Mint permanent token" form (platform app
    or own app; expiry never, 1 day or 30 days; scopes).
- **WhatsApp:** messages (to, template, rendered text, status timeline with the webhook result per step).
- **SMS:** the outbox.
- **Webhooks:** target, verify button, delivery log.
- **Requests:** the last 300 requests (method, redacted path, status, latency, fault applied).
- **Faults:** every control from 3.7.
- **`/meet/:code`:** the mock Meet room, with event details and "not a real meeting".

---

## 5. Environment, workflow and connecting the demo influencer

### 5.1 `.env.example` (add after the readiness block, around line 159)

```
# Local provider mock (development only; scripts/mock-providers, started by `npm run dev:mock`). Points Google (OAuth,
# Calendar, Gmail) and Meta (Graph API, the Embedded Signup SDK) at a local mock server instead of the real services.
# Honoured only when NODE_ENV is development/test, APP_URL is localhost / 127.0.0.1 / [::1] / *.localhost, and this is
# http://127.0.0.1:<port> (or localhost / [::1]); otherwise ignored with a warning, and in production the app refuses to
# start. Leave it EMPTY here: `npm run dev:mock` sets it, with matching fake credentials, for the processes it starts.
MOCK_PROVIDERS_URL=
```

The existing test at `tests/env.test.ts:175-183` then requires the name in `KNOWN_ENV_VARS` (section 2.7).

### 5.2 `package.json` scripts (no new dependencies)

```
"mock:providers": "tsx scripts/mock-providers/index.ts",
"dev:mock": "tsx scripts/dev-mock.ts"
```

Also add `scripts/mock-providers`, `scripts/dev-mock.ts` and `scripts/dev-mock-worker.ts` to `.dockerignore` (the Dockerfile's build stage runs
`COPY . .`). Mock code then never enters an image.

### 5.3 The launcher: `npm run dev:mock [-- --app-url http://localhost:5173 --next-port 3000] [--port 4010] [--reset] [--with-worker [--allow-shared-stores]]`

**There is no worker by default** (an earlier draft started one). The worker is not only "the demo's jobs": two of its timers
sweep the whole database, `worker/google-health.ts` (Google, every influencer) and `worker/whatsapp-sync.ts` (Meta, every
WhatsApp connection), and within a couple of minutes of its start they would ask the mock about every connection in that
database. The mock answers `invalid_grant` / error 190 for every token it did not issue, so **every other influencer in a shared
database would be marked reconnect-needed or ERROR, alerted, and their booking page taken offline.** The worker also consumes
whatever is queued on the Redis it connects to (other users' jobs, which would get mock Meet links), and conversely any OTHER
worker on that Redis (yours, the owner's) picks up the demo's jobs and sends `MOCK-NOT-REAL` tokens to the real Google and Meta.
The rules (the pure function `planWorker` in `scripts/dev-mock-worker.ts`):

- Without `--with-worker`: no worker. The banner says what that means (no Meet link, no confirmation messages, no hold expiry)
  and how to run those steps safely (below).
- With `--with-worker` the launcher **refuses to start anything** unless (a) `DATABASE_URL` and `REDIS_URL` both name this machine
  (`localhost`, `127.0.0.1`, `[::1]`; unset or malformed does not count) and (b) no other worker heartbeat is live on that Redis
  (read with the app's own `readHeartbeat`, lib/health.ts: younger than `HEALTH_WORKER_STALE_SECONDS`, default 180 s; a Redis that
  cannot be read fails closed). It prints the hosts (never credentials) and why.
- `--allow-shared-stores` overrides both checks. Its help text states the consequences above. When it overrides something the
  startup banner carries a warning line (the sweeps can reach a shared store); with clean local stores it prints nothing extra.
- To run the worker-dependent steps (6.6 steps 6 onwards) safely: use a Postgres and Redis dedicated to the demo (local, for
  example `docker run -p 5432:5432 postgres:16-alpine` and `docker run -p 6379:6379 redis:7-alpine`, then
  `npx prisma migrate deploy` and `npm run db:seed`), give their URLs to the launcher (in `.env`, or in the shell:
  `DATABASE_URL=… REDIS_URL=… npm run dev:mock -- --with-worker`; the shell wins over `.env`), stop your own `npm run worker` and
  make sure nobody else's worker uses that Redis.

1. **Refuse to start** when any of these holds: `NODE_ENV=production`, a serverless marker is set, or the target
   `APP_URL` fails `isLocalAppUrl`. The target defaults to `http://localhost:3000`; `--app-url` changes it.
2. **Read** (without assigning to `process.env`) `.env`, using `util.parseEnv` from Node 22.
   - With `--with-worker`: decide whether a worker may start (above); warn if `REDIS_URL` is missing.
   - Warn if `RAZORPAY_KEY_ID` is not `rzp_test_…`.
   - Print the **host only** of `DATABASE_URL` and warn if it is not local: "fake connections and the demo's bookings will be
     written to this database". (The web process writes there even without a worker.)
3. **Start the mock server in-process** (`createMockServer`) on `127.0.0.1:<port>`.
   Before the children start, the launcher also starts the React app's watch build (`scripts/dev-spa.ts`, the same one `npm run dev` uses; `[web]`
   lines), because Next serves the app from the files that build writes.
4. **Spawn the children** with `env = { ...process.env, ...mockEnvOverlay(mockUrl, appUrl) }`, so the overlay wins over
   `.env`. Neither Next nor dotenv overrides an existing variable, and `.env` stays untouched.
   - `next dev`: `process.execPath <require.resolve("next/dist/bin/next")> dev`.
   - The worker: `process.execPath --import tsx worker/index.ts`. Only with `--with-worker` and only when the rules above allow it.
   - Use `stdio: "pipe"` and prefix each line with `[next]`, `[worker]` or `[mock]`. This works on Windows with no shell.
5. **Banner:** "MOCK PROVIDERS ACTIVE: Google and Meta are mocked. Control page http://127.0.0.1:4010/__mock · App <appUrl>
   · Log in as demo@example.com".
6. **Shutdown.** Ctrl+C, a closed console window (SIGHUP, and SIGBREAK on Windows), a kill, or any child exiting stops everything
   and closes the server. The children are stopped first, synchronously (`taskkill /T /F` on Windows), so closing the window
   does not leave `next dev` or the worker running.

The overlay, from `fixtures.mockEnvOverlay`, is the **only** place these values exist:

| Variable | Value |
|---|---|
| `MOCK_PROVIDERS_URL` | `http://127.0.0.1:<port>` |
| `APP_URL` | `<appUrl>` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | the fixtures (3.6) |
| `GOOGLE_REDIRECT_URI` | `<appUrl>/api/google/callback` |
| `GOOGLE_REQUEST_GMAIL_SEND` | `true` |
| `META_APP_ID` / `META_APP_SECRET` / `WHATSAPP_APP_SECRET` / `META_ES_CONFIG_ID` | the fixtures |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | the fixture |
| `WHATSAPP_TEMPLATE_LANGUAGE` | `en` |
| `WHATSAPP_DISABLED` / `WHATSAPP_PLATFORM_FALLBACK` / `MESSAGING_DRY_RUN` | `false` |
| `SMS_PROVIDER` | `generic` |
| `SMS_API_URL` | `<mock>/sms/send` |
| `SMS_API_KEY` | the fixture |

`READINESS_*`, `EMAIL_PROVIDER`, `WHATSAPP_GRAPH_VERSION` and everything else keep the owner's `.env` values. With
`META_APP_ID` and `META_ES_CONFIG_ID` set, `proxy.ts:28` widens the CSP for Facebook hosts, which is harmless, and the
"Connect with WhatsApp" button appears.

`npm run mock:providers` runs the server alone. `-- --print-env` prints the overlay as PowerShell (`$env:NAME = "…"`)
and POSIX (`export NAME=…`) lines for manual terminals, with the warning "do not put these in .env". Some test files load
`.env` (`tests/whatsapp-connect.test.ts:1`), and tests that assert real hosts would then fail:
`tests/gmail.test.ts:57`, `tests/google-connect.test.ts:103,116,127`, `tests/whatsapp-connect.test.ts:1213-1231`.

### 5.4 Prerequisites (state them in the README section)

- Postgres and Redis reachable; `.env` with `DATABASE_URL`, `REDIS_URL`, `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`.
- `npx prisma migrate dev` and `npm run db:seed`.
- **Razorpay test-mode keys** (`rzp_test_…`; self-serve in the Razorpay dashboard, but confirm sign-up does not block
  test keys), `RAZORPAY_WEBHOOK_SECRET` set to any value, and `PAYMENT_RECOVERY_ENABLED=true`, which is the default.
- Use a development database. Fake connections and the demo's bookings are written to whatever `DATABASE_URL` points at.
- **Steps that need the worker (the Meet link, the confirmation messages, hold expiry, payment recovery) need a Postgres and a
  Redis dedicated to the demo**, on this machine, with no other worker on that Redis (5.3). Stop your own `npm run worker`
  first (it would take the demo's jobs and send the mock's tokens to the real Google and Meta). Never point the demo's worker at
  a shared or production database: its sweeps would mark every other influencer's Google and WhatsApp connection broken.
  Without such stores run the launcher without a worker (the default) and walk through steps 1 to 5 only (connecting, booking).

### 5.5 How the demo influencer gets connected

Through the **real UI only**. No database shortcuts and no seed changes.

1. Log in as `demo@example.com` (seed password, development only; or `npm run dev:logins`).
2. Google: Settings, then Google Calendar, then **Connect Google Calendar**, then the mock consent page, then **Allow**.
   The settings page shows "Connected as creator@mock-google.invalid", "Gmail on".
3. WhatsApp, either way:
   - **Connect with WhatsApp**: mock popup, choose WABA 1001 and phone 2001 (fresh), Finish.
   - **Enter details manually**, with values from the mock's Manual connect kit: WABA 1002, phone 2003, and a minted
     platform-app token.

   Connecting needs a recent password entry (`requireRecentAuth`, `app/api/dashboard/whatsapp/route.ts:51`), which is
   satisfied right after logging in.
4. The seed already has verified payout details (`prisma/seed.ts:47-65`). With Google connected, the page is live under
   the real readiness rules (`lib/readiness.ts:89-93`), and `READINESS_BYPASS` is not needed.

### 5.6 Documentation

- **README:** a new section "Try the integrations without Google or Meta accounts". It covers what the mock is, the
  prerequisites, `npm run dev:mock`, the walk-through (6.6, short form) and the "does not prove" list (7.2, short form).
  Keep the sentence at `README.md:290-292` true and add "the local mock exercises the app's side only".
- **`doc/08-deployment.md` section 4:**
  - a row in "Product settings, monitoring and misc":
    `| MOCK_PROVIDERS_URL | no | none | **Dev only**: points Google and Meta at the local mock (npm run dev:mock). Refused in production; ignored unless APP_URL is local |`;
  - in section 5, a bullet under the production refusals: `MOCK_PROVIDERS_URL` set, or a variable holding a
    `MOCK-NOT-REAL` placeholder.

---

## 6. Work breakdown: one Sonnet implementer, branch `feature/provider-simulator`

### 6.1 Rules

- Cut from `main`. No new dependencies. No Prisma schema or migration changes.
- No edits outside the file list in 6.2. In particular, do **not** touch:
  - `lib/meeting.ts`, `lib/manage.ts`, `lib/messaging.ts`, `lib/whatsapp-connection.ts`, `lib/customer-email.ts`;
  - any route, `proxy.ts`, `next.config.ts`, `lib/payments.ts`.
- The mock server never imports `lib/` and never touches the database.
- If anything seems to need a production change beyond section 2, **stop and ask**. Examples: CSP, the origin check at
  `WhatsAppConnect.tsx:135`, a job.
- Run `npm run typecheck`, `npm test` and `npm run build` before each push. `build` also runs `build:web` and
  `scripts/spa-postbuild.mjs`, which fails the build on any `process.env` reaching the browser bundle. This guards the
  `WhatsAppConnect` change.

### 6.2 Files owned

| Production (small; review line by line) | Mock (new) | Tests (new or updated) | Docs and config |
|---|---|---|---|
| `lib/provider-endpoints.ts` (new) | `scripts/mock-providers/*.ts` (3.1) | `tests/provider-endpoints.test.ts` | `.env.example` |
| `lib/facebook-sdk.ts` (new) | `scripts/dev-mock.ts` | `tests/mock-providers-boundary.test.ts` | `package.json` (2 scripts) |
| `lib/google.ts` | | `tests/mock-providers-google.test.ts` | `.dockerignore` |
| `lib/gmail.ts` | | `tests/mock-providers-meta.test.ts` | `README.md` |
| `lib/whatsapp-graph-version.ts` | | `tests/mock-providers-webhooks.test.ts` | `doc/08-deployment.md` |
| `lib/whatsapp-connect.ts` | | `tests/mock-providers-security.test.ts` | |
| `lib/whatsapp.ts` | | `tests/mock-providers-meeting-db.test.ts` (DB-gated) | |
| `components/app/WhatsAppConnect.tsx` | | `tests/mock-providers-whatsapp-db.test.ts` (DB-gated) | |
| `lib/env.ts` | | `tests/env.test.ts`, `tests/whatsapp-connect.test.ts` (import of `graphBase` only) | |

Estimated size: about 150 lines of production diff, about 2,000 lines of mock, about 1,000 lines of tests.

### 6.3 Commit sequence (each commit green)

1. `feat(providers): one module for provider base URLs, with a guarded local-mock override`. Covers 2.1–2.5 and 2.7, with
   the tests from 2.8 except item 6.
2. `feat(whatsapp): the Facebook SDK URL can come from the server (loopback mock only)`. Covers 2.6, the
   `embeddedSignupConfig` tests and `chooseFacebookSdkUrl`, and `npm run build` green.
3. `feat(mock): server skeleton`: http, host, same-origin and control-token checks, state persistence, faults, request
   log, the UI shell with `esc()`, and the security tests.
4. `feat(mock): Google`: consent, token, revoke, Calendar, Gmail, and the Google contract tests.
5. `feat(mock): Meta`: Graph, template review, the Embedded Signup popup and `sdk.js`, messages, the SMS sink, and the
   Meta contract tests.
6. `feat(mock): signed webhooks`: delivery queue, verify handshake, and the webhook tests.
7. `feat(mock): inbox pages, activity feed, Meet room`.
8. `feat(mock): npm run dev:mock launcher`, with docs, `.env.example` and `.dockerignore`.
9. The DB-gated integration tests, then the manual acceptance walk-through (6.6), with results recorded in the PR
   description.

### 6.4 Tests

Tests use `node:test` like the rest. Each mock test starts `createMockServer({ port: 0, appUrl, stateFile: <tmp> })` and
closes it in `after`. Tests set fast timings through the control API (`meta.review=auto:0`, `meta.status` with 20 ms
steps) so they finish in seconds. The pure tests need no network beyond loopback.

**`tests/mock-providers-google.test.ts`** drives the **real** lib clients against the mock:

- Set `process.env` first: `NODE_ENV=test`, `APP_URL`, `MOCK_PROVIDERS_URL`, and the Google fixtures.
- OAuth:
  - The consent page answers 200 and contains "not Google".
  - The decision POST with the control headers gives a 302 with `code` and `state`.
  - `exchangeCode(code)` gives a `MOCK-NOT-REAL-` refresh token, a scope with both scopes, and email
    `creator@mock-google.invalid`.
  - Reusing the code throws `GoogleRequestError`.
  - Unticking Gmail gives a scope without `gmail.send`. Unticking Calendar gives a scope without `calendar.events`.
  - A non-offline request throws "did not return a refresh token".
  - A wrong `redirect_uri` gives the error page and no redirect.
- Calendar:
  - `refreshAccessToken`, then `insertEvent` gives a `meetLink` starting `<mock>/meet/`.
  - Inserting the same id again gives `"exists"`.
  - `getEvent` works.
  - `addAttendee` with `google.patch412=once` succeeds, and the request log shows a 412 and then a 200 with `If-Match`.
  - `removeAttendee` and `updateEvent` work.
  - `deleteEvent`, then `getEvent` gives `status: "cancelled"`; inserting the same id again gives `"exists"`; after a
    purge, `getEvent` gives `null`; deleting again resolves.
- `google.meet=pending_2s`: the insert gives `conferenceStatus: "pending"`, and a get 2 s or more later gives a link.
- Faults:

  | Fault | Expected error |
  |---|---|
  | refresh `invalid_grant` | `GoogleReconnectError` |
  | refresh `invalid_client` | `GoogleTransientError` |
  | calendar `401` | `GoogleReconnectError` |
  | calendar `403_accessNotConfigured` | `GoogleTransientError` |
  | calendar `403_insufficientPermissions` | `GoogleReconnectError` |
  | calendar `429` / `500` | `GoogleTransientError` |
  | revoke the grant via the control API, then refresh | `GoogleReconnectError` |
  | `revokeToken(rt)`, then refresh with another refresh token of the same grant | `GoogleReconnectError` (whole-grant revoke) |

- Gmail:
  - `sendGmail` returns an id, and the state's `sentMail` has the decoded subject and text, a non-ASCII subject
    round-trips, and `from` is the account.
  - With `google.gmail=403_accessNotConfigured`: `GoogleRequestError` mentioning the Gmail API.
  - A grant without `gmail.send`: `GoogleRequestError` (403 `insufficientPermissions`).
- `latency.google=300` delays responses by at least 300 ms. The 15 s timeout is a manual check (6.6), not a unit test.

**`tests/mock-providers-meta.test.ts`:**

- Phone and WABA:
  - Mint a platform token, then `getPhoneNumber` returns the display phone and verified name.
  - `wabaOwnsNumber` is true for the right WABA and false for another.
- Token inspection:
  - `inspectToken` (app creds from fixtures) gives valid with both scopes.
  - An own-app token: the request log shows two `debug_token` calls (the second a self-inspection), and the result is
    valid.
  - A 1-day token: `checkTokenInfo` refuses it.
  - A token missing messaging: refused.
- Subscription: `subscribeApp` with a platform token gives `{ subscribed: true }`; with an own-app token gives
  `{ subscribed: false, reason: /different Meta app/ }`.
- PIN and register:
  - `registerNumber` on 2001 with "111111" works, and repeating it works.
  - On 2002 with "000000": `WhatsAppGraphError` with `pinMismatch`.
  - Five wrong attempts, then `pinLocked`.
  - `setTwoStepPin("990000000002002", t, "222222")`, then `registerNumber` with "222222" works.
- Templates:
  - `ensureTemplates("990000000001001", t, "en")` gives `submitted.length === 5` and all `PENDING`; a second call gives
    `submitted.length === 0`.
  - A direct duplicate create gives an error for which `isAlreadyExists(e)` is true.
  - `ensureTemplates` on 1002 gives `templates.reschedule.status === "CONFLICT"`.
  - `listTemplates` on 1003 returns 150 or more, proving paging works.
- `exchangeEmbeddedCode(code)` with a code from `/__mock/meta/es-code` returns a token; reusing it throws
  `WhatsAppGraphError`.
- `sendWhatsApp` (with credentials, `MESSAGING_DRY_RUN` and `WHATSAPP_DISABLED` unset):

  | Situation | Expected |
  |---|---|
  | template not approved | throws, code 132001 |
  | after approving via the control API | `providerMessageId` starts with `wamid.MOCK-NOT-REAL-`, and state `messages[...].rendered` contains the Meet link and the service title |
  | revoked token | `invalidToken` |
  | `meta.send=10` | `invalidToken` |
  | unregistered phone | 133010 |
  | wrong parameter count (call `sendWhatsApp` with one parameter) | 132000 |

- `sendSMS` with `SMS_PROVIDER=generic` and the overlay values returns an id, and the outbox has the body.

**`tests/mock-providers-webhooks.test.ts`** uses a local receiver (`http.createServer` on `127.0.0.1:0`) that plays the
app. `APP_URL` points to it.

- Approving a template delivers a POST for which `verifyMetaSignature(raw, header, fixtures.META_APP_SECRET)` is true.
  `parseTemplateStatusUpdates(JSON.parse(raw))` deep-equals
  `[{ wabaId: "990000000001001", name: "sa_booking_confirmation", language: "en", status: "APPROVED", reason: null }]`.
- Reject with a reason gives `status: "REJECTED"` and that reason.
- A send gives three deliveries in order, which `parseWhatsAppStatuses` maps to SENT, DELIVERED and READ.
- `failed_131026` gives FAILED with an error string.
- `app_500_once`: the receiver gets the same body twice and the log shows two attempts.
- `bad_signature`: `verifyMetaSignature` is false.
- `meta.webhooks=off`: nothing arrives.
- A WABA without the platform app subscribed gets no deliveries.
- The verify handshake passes against a receiver that echoes `hub.challenge` when the token matches, and fails otherwise.

**`tests/mock-providers-security.test.ts`:**

- `createMockServer` rejects when `NODE_ENV=production`, when `appUrl` is `https://app.example.com`, and when `VERCEL=1`.
- The bound address is `127.0.0.1`.
- `Host: evil.example` gives 421.
- A control POST without the token or with `Sec-Fetch-Site: cross-site` gives 403.
- `Authorization: Bearer ya29.something-real-looking` gives 401, and neither the response body nor
  `state().requests` contains that string.
- Every minted credential starts with `MOCK-NOT-REAL-`. No Meet link starts with `https://meet.google.com`.
- A Gmail message whose HTML contains `<script>alert(1)</script>` and whose subject contains `<img onerror>`: the Gmail
  page HTML contains neither as raw markup, and the HTML part is inside `<iframe sandbox`.
- The state file path starts with `os.tmpdir()`.
- No response contains `GOOGLE_CLIENT_SECRET` or `META_APP_SECRET`.
- Webhook target `https://example.com/hook` is refused.

**DB-gated** (skip without `DATABASE_URL`; own influencer and service with timestamped slugs; deleted in `after`;
**no Redis needed**):

- `tests/mock-providers-meeting-db.test.ts`:
  - Run the OAuth via the mock, then `saveGoogleToken`.
  - Create a PAID booking, then call `createMeetingForBooking(id, { enqueueSendMessage: noop, enqueueReminders: noop, sendBookingEmail: noop })`.
  - Expect `"scheduled"`, `meetLink` starting `<mock>/meet/`, and the mock calendar holding event `calendarEventId(id)`
    with the customer as attendee.
  - Revoke the grant in the mock, then a second booking: `MeetingBlockedError`, and `googleToken.status` is
    `RECONNECT_NEEDED`.
  - A group service with two bookings: one shared event with two attendees.
- `tests/mock-providers-whatsapp-db.test.ts`:
  - `connectEmbedded` (real deps) with an `es-code` for 1001/2001: connection ACTIVE, webhook subscribed, a PIN row
    exists, 5 templates PENDING.
  - Approve all with the receiver in place, then feed the received bodies through
    `parseTemplateStatusUpdates` → `applyTemplateStatusUpdate`: `getConnectionView(...).ready === true`.
  - Phone 2002: `WhatsAppConnectError` with `canReset`. Again with `resetPin: true`: success, and the mock phone PIN
    equals the saved PIN.

### 6.5 Definition of done

- `npm run typecheck`, `npm test` (with and without `DATABASE_URL`) and `npm run build` all pass.
- The boundary test passes.
- `git grep -n "MOCK_PROVIDERS_URL" -- lib app components worker web/src proxy.ts` lists only
  `lib/provider-endpoints.ts` and `lib/env.ts`.
- The walk-through below is done once by the implementer, and the PR records each step's result. Any step that could not
  be done is listed with the reason.

### 6.6 Acceptance walk-through (manual, about 30 minutes)

Prerequisites from 5.4. Run `npm run dev:mock` for steps 1 to 5 (no worker), and `npm run dev:mock -- --with-worker` against a
dedicated local Postgres and Redis for steps 6 onwards (5.3: the launcher refuses a worker otherwise). Open
`http://127.0.0.1:4010/__mock` in one tab and `http://localhost:3000` in another. Expected results are in *italics*.

1. **Start.** *The banner prints (and says the worker is NOT started, or that it is). The web log shows the `[env] warning
   (web): MOCK_PROVIDERS_URL: ACTIVE…` line, and so does the worker log when there is a worker. The mock overview is empty.*
   Also check the refusal: `npm run dev:mock -- --with-worker` with a non-local `DATABASE_URL` or `REDIS_URL` (or while your
   own worker runs). *It exits 1 before starting anything and names the host, never the credentials.*
2. **Production refusal (the inert check).**
   - `NODE_ENV=production MOCK_PROVIDERS_URL=http://127.0.0.1:4010 npx tsx -e "require('./lib/env').initEnvOrExit('check')"`
     (or the PowerShell equivalent). *It exits 1 with `MOCK_PROVIDERS_URL: must not be set in production` and the value
     is not printed.*
   - With `APP_URL=https://app.example.com` in development: *a warning that the REAL services are used.*
3. **Connect Google.** Log in as demo, open Settings, then Connect Google Calendar.
   - *The mock consent page appears with the red banner, both permissions ticked, and the account chooser.* Allow.
     *Back on Settings: "Google connected…", "Connected as creator@mock-google.invalid", "Gmail on".*
   - *The mock Google tab shows a grant with both scopes, and the request log shows `POST /google/token 200`.*
   - Variations:
     - Cancel. *"Google access was not granted…"*
     - Untick Calendar. *"Calendar permission was unticked…" The mock shows the grant revoked (the callback revoked it,
       `callback/route.ts:63-65`).*
     - Untick Gmail. *"connected-no-gmail" text.*
4. **Connect WhatsApp (Embedded).** Settings, then WhatsApp, then **Connect with WhatsApp**.
   - *The popup "MOCK Embedded Signup" appears with the banner.* Choose 1001 / 2001, then Finish. *Toast "WhatsApp
     connected…". The card shows +91 00000 02001 · Mock Coaching, with templates "In review".*
   - About 15 s later: *the mock webhook log shows 5 deliveries with 200. After a refresh the card shows all "Approved"
     and the badge "Ready".*
   - Also do these:
     - (a) Disconnect, then connect via **Enter details manually** with the kit for 1002 / 2003 and a platform token.
       *Reschedule shows "Name already used" (CONFLICT).*
     - (b) Disconnect, then Embedded with **2002**. *A PIN error with the "reset it for me" checkbox.* Tick it and
       connect again. *Success. The mock phone shows the PIN changed.*
     - (c) Embedded, then Cancel at `PHONE_NUMBER_SETUP`. *Toast "WhatsApp sign-up was cancelled at the "phone number
       setup" step."*
     - (d) Manual connect with a 1-day token. *Refused with the "expires in" message.*

     Leave the account connected to 1001 / 2001 at the end.
5. **Book and pay.** Open `http://localhost:3000/demo`, book the 1:1 with your own test name and email, any valid +91
   mobile, and WhatsApp opt-in ticked. Pay in the Razorpay **test** checkout with a Razorpay-documented test card.
6. **Within about 5 minutes** (needs the worker, so the dedicated local stores and `--with-worker`; recovery: orders at least 3
   minutes old, every 2 minutes):
   - *The worker logs payment recovery and then `[create-meeting] booking … scheduled`.*
   - *The mock Calendar shows the event with you as attendee and a `/meet/mock-…` link. The invite log shows "Google
     would email an invite".*
   - *The Gmail outbox shows the confirmation from creator@mock-google.invalid, with the manage link.*
   - *WhatsApp shows `sa_booking_confirmation` with the rendered text including the Meet link, then statuses sent,
     delivered and read.*
   - *In the app: the Sessions board shows the Meet link (and opening it shows the mock Meet room); the Messages page
     shows WhatsApp DELIVERED, then READ.*
7. **Customer self-service.** Open the manage link from the mock Gmail detail.
   - Reschedule. *The mock event is PATCHed: new time, sequence +1, update logged. Gmail and WhatsApp `sa_reschedule`
     are sent.*
   - Cancel. *The event becomes a tombstone, a cancellation is logged, and `sa_cancellation` is sent.*
8. **Gmail failure.** Set the fault `google.gmail=403_accessNotConfigured`, then use "Resend link" on a booking. *The web
   log shows the `[email]` platform fallback line and the once-an-hour Gmail warning. Settings shows "Gmail not working".*
   Clear the fault.
9. **WhatsApp token revoked.** Revoke the WhatsApp token in the mock, then make a new booking (or resend).
   - *The WhatsApp attempt fails with 190. The card shows "Reconnect needed". The SMS outbox has the message.*
   - Reconnect (the Reconnect button, then Embedded). *Ready again.*
10. **Google reconnect-needed.** Revoke the Google grant in the mock, then make another booking. *create-meeting fails
    with `invalid_grant`. Settings shows "Reconnect needed (Refresh token rejected: Token has been expired or revoked.)".
    The booking stays PAID with `lastError`. The public booking page shows the owner preview and holds are refused.*
    Reconnect. *The callback re-queues; the Meet link appears.*
11. **Disconnect.**
    - Google, with upcoming events. *The confirmation dialog appears.* Confirm. *The mock shows `POST /google/revoke`
      and the grant revoked.*
    - WhatsApp. *The card shows Not connected.*
12. **Optional:**
    - `latency.google=16000`, then a booking. *A transient timeout, then a retry after clearing.*
    - `google.meet=pending_forever`. *Retries, then a failure alert after 5 attempts.*
    - `meta.webhooks=off`. *"Check template status" picks up approvals.*
    - `meta.status=out_of_order`. *A READ row can regress to DELIVERED (7.4).*
    - Switch account to second-account@… with live events. *The switch warning dialog appears, and a reconnect with a
      different account is refused (`switch-unconfirmed`).*

---

## 7. Risks, and what the mock does not prove

### 7.1 Ways it could mislead the owner, and the mitigations

| Risk | Mitigation |
|---|---|
| **Shared misconception.** The mock is written from the same understanding of Google and Meta as the app. Where that understanding is wrong, both are wrong together and the demo still passes. This is the biggest risk. | The mock never imports `lib/`; parsing and signing are implemented twice. Each response shape cites the provider's doc URL in a code comment. Every mock page carries the "does not prove" banner. The README keeps "still needs a pass against a real Meta account" (`README.md:290-292`). |
| **Speed and ease.** Approval in 15 s, instant Meet links, no consent warnings. Real life: Meta review takes minutes to 24 hours and may reject or re-categorise templates; Google shows "Google hasn't verified this app"; Testing-mode refresh tokens die after 7 days. | Next to each timer, the mock pages state the real-world expectation. These facts are also in 7.2 and the README. |
| **Looks finished.** A working demo can read as "integrations done". | The PR and README say plainly: app-side flows verified against a mock; provider-side unverified until the checklist in 7.5. |
| **Embedded Signup.** The synthetic `MessageEvent` passes the facebook.com origin check by construction. | Stated on the popup. It proves the component's handling, not Meta's messages. If the component later checks `event.source` or `isTrusted`, the mock breaks loudly, which is acceptable. |
| **Different-looking links.** Meet links are on the mock origin, not `meet.google.com`. | Intentional (3.3). Mentioned on the Meet room page. |

### 7.2 What it does NOT prove

**Google**

- The real consent screen: the unverified-app interstitial, test-user restrictions, and `gmail.send` restricted-scope
  verification and security assessment.
- `calendar.events` verification.
- The exact returned `scope` string, and incremental-auth semantics.
- Whether a refresh token comes back on re-consent.
- Account chooser behaviour with `login_hint`.
- The 7-day expiry of Testing-mode tokens.
- `redirect_uri` registration in Cloud Console.

**Calendar**

- Real Meet creation latency and failure rates; behaviour of reused `requestId`s (the mock always creates a new
  conference).
- Tombstone lifetime and when 404 becomes 410; whether a patch on a tombstone restores it; etag format.
- Quotas and rate limits.
- Invitation emails actually sent by Google (the mock only logs them).
- The 60-minute group-call cap on free accounts (`lib/meeting.ts:339-343`).
- Time-zone rendering in invites.

**Gmail**

- Deliverability and spam placement; real `From` rewriting.
- Daily send limits.
- MIME acceptance quirks.
- Google's exact `accessNotConfigured` text.

**Meta**

- The Embedded Signup popup, its steps, the `WA_EMBEDDED_SIGNUP` / `sessionInfoVersion` 3 message format and its timing
  relative to the code.
- Tech Provider approval.
- What `debug_token` really reports for Embedded Signup tokens (type, expiry, granular scopes).
- Template review outcomes and timing, and category changes (UTILITY to MARKETING).
- Exact error codes and subcodes **other than** those the app depends on (190, 10, 200–299, 133005, 133008, 133009,
  2388023/2388024). 100/33, 132000, 132001, 132015, 132016, 132018, 133010, 131026 and the message texts are
  approximations.
- Messaging limits and tiers, quality rating, the 24-hour window, display-name approval.
- PIN lockout thresholds and timings.
- Webhook semantics:
  - retries for up to 7 days;
  - several statuses or entries batched into one POST (the mock sends one status per POST; the app's parsers do handle
    arrays);
  - duplicates and out-of-order delivery (only as an opt-in fault);
  - the requirement to configure the callback URL, verify token and subscribed fields in the Meta App dashboard;
  - a public HTTPS URL (Meta cannot reach `localhost`).
- That a given Graph version is still live: the mock accepts any `vNN.N`.

**SMS:** DLT registration and MSG91 or Twilio behaviour. The generic sink is used.

**Razorpay:** nothing is mocked. The real test mode is used, and its webhook is replaced by the recovery poll locally.

### 7.3 Operational risks

- **Mock values in `.env`.** If the owner pastes the overlay into `.env`, tests that assert real hosts fail (5.3).
  `dev:mock` never writes `.env`, and `.env.example` says to leave the variable empty.
- **Fake rows in the database.** Mock tokens, links, WABA ids and `@mock-google.invalid` emails are stored in whatever
  database `DATABASE_URL` points at. The launcher warns about a non-local host. Real connections later replace them
  through the normal connect flows. Mock tokens sent to real Google fail with `invalid_grant`, which shows "Reconnect
  needed", which is self-healing.
- **The worker's sweeps (the serious one).** `worker/google-health.ts` and `worker/whatsapp-sync.ts` walk **every**
  influencer's connections in the database and ask the provider about each. With the app pointed at the mock, the mock
  rejects every token it did not issue (`invalid_grant`, error 190), so a worker running against a shared database marks every
  other influencer's connection reconnect-needed or ERROR, alerts them and takes their booking page offline, within minutes of
  its start. The worker also consumes whatever is queued on its Redis (other users' jobs would get mock Meet links), and any
  OTHER worker on that Redis (yours, the owner's) picks up the demo's jobs and sends the mock's tokens to the real Google and
  Meta. Therefore: **no worker by default**; `--with-worker` is refused unless both stores are on this machine and no other
  worker heartbeat is live (`lib/health.ts`); `--allow-shared-stores` overrides it, with the consequences in its help text and a
  banner warning; to run the worker-dependent steps, stop your own worker and use a dedicated local Postgres and Redis (5.3).
- **Leftover personal data.** The mock's state file holds the customer names, emails, phones and messages typed into the demo.
  It lives in a per-user directory (0700, file 0600) in the OS temp directory; delete it with `--reset` when done.
- **Mock SDK under CSP.** It relies on `'strict-dynamic'` propagation (`proxy.ts:116`). A browser without CSP3
  `strict-dynamic` support falls back to the host allow-list and blocks `127.0.0.1`. The fix then is to use manual
  connect, **not** to widen the CSP without review. The implementer checks for console CSP violations in Chrome during
  step 4 of the walk-through.
- **SPA bundle.** The `WhatsAppConnect` change must not pull `process.env` into the Vite bundle. That is why
  `lib/facebook-sdk.ts` is import-free and `graphBase` moves out of the client-shared module. `npm run build` proves it.
- **Merge overlap with SPA branches.** Small overlaps in `lib/env.ts`, `.env.example`, `README.md`, `package.json` and
  possibly `components/app/WhatsAppConnect.tsx`. `spa/31-dashboard-setup` must forward `embeddedSignupConfig()` intact
  (2.6).
- **State drift.** After `--reset` or a deleted temp file, every connection the app stored is unknown to the mock, and
  the app shows reconnect states. Documented; this is the correct behaviour.

### 7.4 Issues noticed while reading (outside this branch; do not fix here)

1. **Status regression.** The WhatsApp webhook route writes the status unconditionally
   (`app/api/webhooks/whatsapp/route.ts:50-56`). Meta does not guarantee order, so a late `delivered` after `read`
   regresses the row to DELIVERED. The mock's `meta.status=out_of_order` fault demonstrates it. Suggested follow-up: only
   move forward (`PENDING < SENT < DELIVERED < READ`, with FAILED terminal).
2. **Lost `sent` status.** A `sent` webhook that arrives before `sendMessageForBooking` upserts its Message row
   (`lib/messaging.ts:187-199`) matches nothing and is dropped. Later statuses repair it, but `meta.status=instant`
   shows the gap.

### 7.5 Real-provider checklist (the next step, once accounts exist)

In order of risk:

1. The Embedded Signup message contract and order, and the code exchange with the real Meta app.
2. `debug_token` output for Embedded Signup and System User tokens.
3. Webhook configuration in the Meta dashboard, with a real signature, through a public URL.
4. Template review results for the five `sa_*` bodies.
5. Meet creation and invite emails on a real Calendar, including group events, attendee PATCH with a real etag, delete
   then re-insert of the same id, and the tombstone behaviour.
6. Gmail send from a test user: `From`, deliverability, and `accessNotConfigured` before the API is enabled.
7. Consent-screen wording and scopes in Testing mode, and the 7-day expiry.

### 7.6 Follow-ups (not in this branch)

- **Razorpay mock**, only if the owner cannot get test keys. It would add the same guard for `lib/payments.ts:3`, a mock
  `checkout.js` (two client components) and a signed `payment.captured`. It is roughly half the size of this branch and
  touches payments code, so it needs its own review.
- **The two webhook ordering fixes** in 7.4.
