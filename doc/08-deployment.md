# Phase 8 — Deployment, Operations and Security Hygiene

> How to run this app in production, and what to watch once it is running. Read `README.md` first. Everything below was
> written from the code in this repository; items that could not be verified here are marked **(not verified)** so you
> can check them against your own provider before relying on them.
>
> **Upgrading an existing installation? Read section 16 first** (`APP_SECRET` must now be 32+ characters, and changing it
> invalidates emailed links).

## 1. Architecture

```
                   browser / Razorpay / Meta / Google
                                  │  HTTPS
                          ┌───────▼────────┐
                          │   web          │  Next.js (pages + /api/*), proxy.ts = rate limit + CSRF + CSP
                          │   (stateless)  │  GET /api/health (liveness), GET /api/ready (readiness)
                          └───┬────────┬───┘
              SQL (Prisma/pg) │        │ jobs (BullMQ) + rate-limit counters
                      ┌───────▼──┐  ┌──▼───────┐       ┌────────────────────────────┐
                      │ Postgres │  │  Redis   │◄──────│ worker (one long-lived     │
                      │ (record) │  │ (queues) │       │ process, worker/index.ts)  │
                      └───────▲──┘  └──────────┘       └──────────────┬─────────────┘
                              └───────────────────────────────────────┘
```

| Component | Role | State | Scales by |
|---|---|---|---|
| **web** | Pages, REST API, Razorpay/WhatsApp webhooks. Enqueues jobs. | None (sessions are rows in Postgres) | More instances |
| **worker** | `create-meeting`, `send-message`, reminders (BullMQ), hold expiry every 30 s, housekeeping every ~10 min, WhatsApp template status check every 30 min | None | Replicas are safe (jobs have deterministic ids; hold expiry and sweeps are idempotent) |
| **Postgres** | System of record: bookings, payments, tokens (encrypted), audit log. Also the fallback store for rate limits | **Yes. Back it up.** | Vertical; keep connection counts in mind (section 4, `DATABASE_POOL_MAX`) |
| **Redis** | BullMQ queues (delayed reminder jobs live here) and the primary rate-limit store | Job state. Treat as important, not as a cache | Single instance with persistence |

Availability does not depend on the worker for correctness: slot availability and holds are computed from row locks and
timestamps, so an expiry worker that is not running only leaves stale statuses (`lib/holds.ts`). Payments are marked paid
only by the Razorpay webhook. What the worker does gate is everything *after* payment: the Meet link, the confirmation and the
reminders.

## 2. Hosting

**web** runs anywhere that runs Node 22+ or a container: Vercel, or any container host (Fly.io, Railway, Render, ECS,
Cloud Run, Kubernetes, a VM with Docker). It is stateless; run two or more instances.

**worker** MUST be a long-running process. It holds open BullMQ connections to Redis, runs timers, and processes jobs
whenever they arrive. **Vercel functions cannot host it** (they are request-scoped and are frozen or killed between
requests), and Vercel cron is not a substitute for BullMQ workers. If the web app is on Vercel, run the worker as a container
or VM elsewhere (the `Dockerfile.worker` image is made for this). Pick a plan that keeps one instance always on (no
scale-to-zero, and for Cloud Run "CPU always allocated").

**Postgres**: any managed Postgres 14+. The owner's current setup is a Supabase session-pooler URL. Prisma's migration
command takes advisory locks and expects a direct or session-mode connection; it will not work through a
transaction-mode pooler (PgBouncer `pool_mode=transaction`) **(general Prisma guidance, not tested here)**. This repo has
a single `DATABASE_URL` (`prisma.config.ts` and the app share it), so run the migration job with a direct/session URL in
its own environment.

**Redis**: any Redis the `ioredis` client can reach over TCP (`redis://` or TLS `rediss://`). Upstash works through its
TCP endpoint. Use persistence (AOF or snapshotting) and the **`noeviction`** memory policy: BullMQ stores jobs as keys and
an eviction policy would silently delete them (BullMQ's documentation requires `noeviction` **(not verified here)**).

**Other infrastructure**: a domain with HTTPS in front of web (the app sets HSTS in production), an email provider (Resend
or Postmark) with SPF and DKIM for `EMAIL_FROM`, and the third-party accounts in sections 7, 10 and 11.

## 3. Containers

| File | Image | Purpose |
|---|---|---|
| `Dockerfile` (target `runner`, the default) | web | Next.js **standalone** server (`output: "standalone"`, switched on by `BUILD_STANDALONE=1` so `next start` and Vercel builds are unchanged). Runs as the unprivileged `node` user on port 3000. |
| `Dockerfile` (target `tools`) | tools | Prisma CLI + scripts for one-off jobs: `prisma migrate deploy`, `npm run admin:create`, `npm run keys:rotate`, `npm run keys:verify`. Not a service. |
| `Dockerfile.worker` | worker | `worker/index.ts` under `tsx` with production dependencies and the generated Prisma client. Non-root. Next.js, React and TypeScript are removed from it (the build fails if the worker's imports ever need them). |
| `docker-compose.yml` | all | Local production-like run: postgres, redis, a one-shot `migrate` job, web, worker. |

```
docker build -t sessions-web .
docker build -t sessions-tools --target tools .
docker build -f Dockerfile.worker -t sessions-worker .
```

* **No secret is baked into an image.** `.dockerignore` keeps `.env`, `.env*`, `*.env`, `*.pem` and `*.key` (at any depth,
  except `.env.example`) out of the build context (`COPY . .` in the build stage would otherwise copy them), `.gitignore`
  keeps the same patterns out of git, and none of the Dockerfiles has an `ENV` for a secret. Configuration is passed when the container starts. The only build
  arguments are the public `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `APP_LOCALE` and `ENABLE_DESIGN_PAGE`, which
  Next.js and the React SPA bundle compile into the JavaScript (changing them means rebuilding the web image; section 3.2).
* **Health checks**: the web image's `HEALTHCHECK` calls `GET /api/health`. Point load balancers at `/api/ready`
  (section 3.1). The worker has no HTTP port; its `HEALTHCHECK` runs `scripts/worker-healthcheck.ts` (Redis answers and
  each of the three queues has an attached worker).
* **Local run**: `cp .env.example .env`, fill in `APP_SECRET`, `TOKEN_ENCRYPTION_KEY` and Razorpay **test** keys, then
  `docker compose up --build`. Compose sets `NODE_ENV=production` and wires `DATABASE_URL`/`REDIS_URL` to its own
  containers. Because production mode refuses development settings, compose also sets `ALLOW_INSECURE_LOCAL_RUN=true`,
  which relaxes only those checks and only while `APP_URL` is `http://localhost...` (section 5). Web is published on
  `127.0.0.1:3000` only; Postgres and Redis are not published. In production mode the session cookie is `Secure`; browsers
  accept that on `localhost` (Chrome, Firefox), Safari does not.
* **Running a tool**: keep the environment file for one-off commands **outside the repository** (for example
  `~/secrets/sessions-prod.env`, readable only by you; a file inside the checkout is one `git add -A` or `COPY .` away from
  leaking, which is why `*.env` is ignored by both git and Docker). Then
  `docker run --rm --env-file ~/secrets/sessions-prod.env sessions-tools npx prisma migrate deploy`, or
  `... sessions-tools npm run admin:create -- --email you@company.com --name "You"`. On a platform, prefer its "run a one-off
  command with this service's environment" feature over a file on a laptop. Env files are read verbatim: a trailing space or
  a CRLF line ending becomes part of the value (section 5 rejects that in production).

### 3.1 Health endpoints

| Endpoint | Meaning | Dependencies | Use for |
|---|---|---|---|
| `GET /api/health` | The process is up. `200 {"ok":true}` | None | Liveness / container `HEALTHCHECK`. A database outage must not restart a healthy web process |
| `GET /api/health/watchdog` | Is the background worker alive and is Redis answering? `200`, or `503` when the worker heartbeat is stale or Redis is configured but unreachable (also raises the same alert as the health monitor, at most once an hour) | Redis (heartbeat key) | An EXTERNAL uptime monitor every 1 to 5 minutes. Never a container or load-balancer probe: it fails when the worker is down and must not restart a healthy web process |
| `GET /api/ready` | Can serve traffic. `200 {"ok":true,"checks":{"db":"ok","redis":"ok"}}`, or `503` with the failing check set to `"fail"` | `SELECT 1` on Postgres; `PING` on Redis when `REDIS_URL` is set (`"skipped"` otherwise). 3 s budget each | Load balancer target health, Kubernetes readiness |

Responses are never cached, and contain no error text or connection strings (the log line carries only the error code, at
most once a minute per check). Both bypass the global per-IP rate limit and have their own in-memory limits in
`lib/rate-limit/policies.ts` (`health` 6000/min, `ready` 1200/min, per client IP) so probes keep working while
Redis and Postgres are down. Suggested Kubernetes probes: liveness `/api/health` (period 10 s, timeout 3 s), readiness
`/api/ready` (period 10 s, **timeout 5 s**, failureThreshold 3).

### 3.2 The React front end (SPA) — build outputs, serving, rollback

The whole UI is moving from Next-rendered pages to a standalone React single-page app built with Vite (`web/`; plan and
status in `doc/10-react-migration-plan.md` and `doc/10-react-migration-deviations.md`). Next keeps the JSON API, the webhooks,
the metadata routes (`/sitemap.xml`, `/robots.txt`, `/opengraph-image`, `/icon.svg`) and the worker; the browser still sees
**one origin**, so the `__Host-` cookies, `SameSite=Strict` admin cookie and the Origin/CSRF check are unchanged.

* **Build**: `npm run build` is `vite build` then `next build`. Vite writes `web/dist/index.html` (the HTML shell template) and
  `web/dist/assets/*` (content-hashed JavaScript, CSS and fonts). `scripts/spa-postbuild.mjs` then **fails the build** if the
  template lacks the CSP nonce placeholder or a tag lacks its nonce, if any `process.env` is left in the bundle, or if the value of
  any secret-looking environment variable (names matching `SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL`, from the
  process and from the root `.env` files) appears in `web/dist`; only the variable's name is printed. It then copies `assets/` to
  `public/assets/`, which Next serves as static files with `Cache-Control: public, max-age=31536000, immutable` (see
  `next.config.ts`). Both directories are build outputs (git- and docker-ignored). The Vite config reads exactly four values at
  build time (`NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `APP_LOCALE`, `ENABLE_DESIGN_PAGE`); nothing else from the
  environment can reach the browser, and a build-time guard (`web/vite-server-guard.ts`) stops the build if browser code imports
  server code (database, Node APIs, route handlers).
* **Serving**: `SPA_GROUPS` (run-time, `.env.example`) lists the page groups the SPA serves: `public`, `auth`, `booking`,
  `dashboard`, `admin`, or `all`. For a page in an enabled group `proxy.ts` rewrites the request to the internal route
  `/spa-shell/<path>` (`app/spa-shell`), which renders `web/dist/index.html` with this request's CSP nonce, the route's `<head>`
  (title, robots, canonical, Open Graph, JSON-LD; every inserted value HTML-escaped) and the right status (a real 404 for an
  unknown profile, 503 + `Retry-After` if the lookup fails). Pages in a group that is not listed are served by the old Next pages,
  exactly as before: **with `SPA_GROUPS` empty nothing changes**. `/spa-shell/...` answers 404 when requested directly.
* **Bind address**: do not run the standalone server with `HOSTNAME=127.0.0.1` or `::1` while `SPA_GROUPS` is set. Next.js builds
  the request URL the proxy sees from `HOSTNAME` but rewrites loopback IPs to `localhost`, so the proxy's rewrite to the internal
  shell route is treated as a request to another origin, proxied without the nonce, and every SPA page answers 404. Use
  `HOSTNAME=0.0.0.0` (the image's default) or `localhost` and limit access with the firewall or reverse proxy; the web process
  refuses to start in production with that combination (section 5).
* **Start-up check**: with a non-empty `SPA_GROUPS` the web process refuses to start (section 5) if `web/dist/index.html` is
  missing or has no `__CSP_NONCE__` placeholder. This applies where all code shares one directory (the Docker image,
  `next start`, a VM). On **serverless platforms** (Vercel, AWS Lambda, Netlify, detected from their environment variables) it is
  a **warning** only: every function, and the proxy, is its own bundle with its own traced files and the start-up hook runs in
  each of them, so one bundle without the file must not make all requests through it fail. The same applies to the bind-address
  check below. The shell route itself answers 500 with one log line (`[spa-shell] ...`) if it cannot read the template.
  `next.config.ts` lists the template for the shell route and for all routes (`outputFileTracingIncludes`), but whether the
  proxy bundle receives it is a platform detail: **check a Vercel preview deployment before the cut-over** (open one page of
  every enabled group, and read the function logs for `[spa-shell]` and `[env] warning` lines). The image copies the file explicitly; for a standalone/Vercel bundle
  `next.config.ts` lists it in `outputFileTracingIncludes` (route `/spa-shell/[[...path]]`), because the file is read at run time and the
  tracer cannot see it. Vercel needs no setting change: the build script runs Vite then Next, `public/assets` goes to the CDN,
  and `proxy.ts` already runs on Node.
* **Cut-over and rollback are configuration**: add a group to `SPA_GROUPS` and restart to switch it on; remove it and restart to
  switch it back to the old pages. No code deploy is needed until the cleanup branch deletes the old pages (then rollback is
  redeploying the previous image). Order: `public`, `auth`, `booking`, `dashboard`, `admin`; watch the error webhook, System health,
  4xx/5xx and 429 rates and (for booking) the webhook log and payment-recovery count for 24 hours after each.
* **Stale tabs**: a tab open across a deploy asks for chunk files that no longer exist; `/assets` never falls back to HTML (a
  clean 404), and the SPA reloads once on Vite's `vite:preloadError`.
* **Development**: `npm run dev` (Next, port 3000) and `npm run dev:web` (Vite, port 5173, proxies `/api` and the metadata
  routes to Next, `SPA_API_TARGET`); open the Vite port and set `APP_URL=http://localhost:5173` so e-mailed links and redirects point
  at it. CSP is not applied by the Vite dev server, so check CSP behaviour with `npm run build` and `SPA_GROUPS=all npm start`.
* **Smoke test**: `node scripts/spa-smoke.mjs <base-url> [--no-db] [--old]` (CI runs it against the image started with
  `SPA_GROUPS=all`); it needs no login and no data.

## 4. Environment variables

**Req** = required when `NODE_ENV=production` (start-up validation fails without it, section 5). **Dev** = for local
development only; the start-up validation refuses it in production (`EMAIL_PROVIDER=log`, `MESSAGING_DRY_RUN`,
`WHATSAPP_DISABLED`, `READINESS_BYPASS`, `RATE_LIMIT_ENABLED=false`). Everything else is optional. Build = needed when
the image is built, not at run time. Copy `.env.example` as the starting point.

### Core, database and Redis
| Variable | Req | Default | Notes |
|---|---|---|---|
| `APP_URL` | yes | `http://localhost:3000` | Public origin, **https** in production. Builds every emailed link, the OAuth redirect check and the CSRF allow-list |
| `APP_SECRET` | yes | none | **32+ characters in production** (the absolute minimum anywhere is 16). `openssl rand -base64 32`. Signs manage/pay links and OAuth state. No previous-secret fallback: changing it invalidates links already emailed (section 16) |
| `TOKEN_ENCRYPTION_KEY` | yes | none | 32 bytes, base64. AES-256-GCM key for Google refresh tokens, payout account numbers/UPI ids, WhatsApp tokens. Back it up (section 9) |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | no | none | Rotation only: the old key, tried after the current key when decrypting. `keys:rotate` and `keys:verify` read this and `TOKEN_ENCRYPTION_KEY` (new key), i.e. the services' own variables. Remove it when the rotation is finished (a warning reminds you) |
| `DATABASE_URL` | yes | none | `postgresql://...`. Used by the app, the worker, migrations and scripts |
| `DATABASE_POOL_MAX` | no | `10` | **Per process.** web instances x this + worker replicas x this must stay under the database's connection limit. Hosted poolers allow few (the shared Supabase project here allows 15) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `15000` | Postgres cancels a statement after this long |
| `DATABASE_CONNECT_TIMEOUT_MS` | no | `10000` | How long a request waits for a free pooled connection before failing |
| `DATABASE_IDLE_TIMEOUT_MS` | no | `30000` | Idle connections are closed after this |
| `REDIS_URL` | yes | none | `redis://` or `rediss://`. Required in production (queues, shared rate limits) |

### Rate limiting and proxy
| Variable | Req | Default | Notes |
|---|---|---|---|
| `CLIENT_IP_HEADER` | recommended | `x-forwarded-for` (right-most) | The one header your platform sets with the real client IP: `x-real-ip` on Vercel, `cf-connecting-ip` behind Cloudflare. Never a client-settable header. Unset = a warning at start-up |
| `RATE_LIMIT_STORE` | no | `auto` | `auto` (Redis, failing over to Postgres), `redis`, `postgres`, `memory` (single instance only) |
| `RATE_LIMIT_ENABLED` | no | `true` | **Dev** when `false` (load tests); refused in production |
| `RATE_LIMIT_MULTIPLIER` | no | `1` | Scales every limit |

### Payments (Razorpay)
| Variable | Req | Default | Notes |
|---|---|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | none | `rzp_live_...` for launch; `rzp_test_...` is allowed (with a warning) for staging |
| `RAZORPAY_WEBHOOK_SECRET` | yes | none | Must equal the secret typed in the dashboard's webhook settings |
| `AUTO_REFUND_ON_CANCEL` | no | `false` | `true` refunds eligible cancellations immediately |
| `PAYOUT_HOLD_DAYS`, `PLATFORM_FEE_BPS` | no | `2`, `0` | Payout rules (`lib/payouts.ts`) |

### Google (Calendar, Meet, Gmail)
| Variable | Req | Default | Notes |
|---|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Meet | none | Without them nobody can connect Google, so no Meet links (start-up warning). The Cloud project needs the **Google Calendar API** and the **Gmail API** enabled (section 11) |
| `GOOGLE_REDIRECT_URI` | for Meet | none | Must exactly match an authorised redirect URI: `<APP_URL>/api/google/callback` |
| `GOOGLE_REQUEST_GMAIL_SEND` | no | `true` | Set `false` until the restricted `gmail.send` scope is approved (section 11) |

### WhatsApp and SMS
| Variable | Req | Default | Notes |
|---|---|---|---|
| `WHATSAPP_APP_SECRET` | recommended | none | The Meta app secret. Verifies `X-Hub-Signature-256` on `/api/webhooks/whatsapp`; without it every callback is rejected (warning). Same value as `META_APP_SECRET`: set either one and both uses work |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | recommended | none | Meta's one-time webhook handshake (warning if unset) |
| `META_APP_ID`, `META_APP_SECRET`, `META_ES_CONFIG_ID` | no | none | Embedded Signup (Meta Tech Provider approval); manual connect does not need them. `META_APP_ID` plus the app secret (either name) also let us check a pasted token's permissions and expiry with Meta's `debug_token` when an influencer connects by hand; without them that check is skipped, with a note shown to the influencer. `META_APP_ID` and `META_ES_CONFIG_ID` also widen the CSP at **start-up**, so they must be set on the web service |
| `WHATSAPP_REGISTRATION_PIN` | no | none | **Dev only** (ignored in production): a fixed 6-digit two-step PIN for Embedded Signup numbers. Otherwise each number is registered with its own random PIN, stored encrypted |
| `WHATSAPP_GRAPH_VERSION` | no | in `lib/whatsapp-graph-version.ts` | Meta Graph API version for every WhatsApp call and the Facebook SDK, e.g. `v26.0`. Meta retires versions on a schedule ([versions and end dates](https://developers.facebook.com/docs/graph-api/changelog/versions)); set this to move without a deploy of new code |
| `WHATSAPP_TEMPLATE_LANGUAGE` | no | `en` | Template language code. Only status updates in this language are applied |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | no | none | The platform's own number; used only with `WHATSAPP_PLATFORM_FALLBACK=true` |
| `WHATSAPP_PLATFORM_FALLBACK` | no | `false` | Testing only; warned about in production |
| `WHATSAPP_DISABLED` | no | `false` | **Dev**: force WhatsApp to fail so SMS fallback is exercised. Refused in production (it silently sends all WhatsApp traffic by SMS) |
| `MESSAGING_DRY_RUN` | no | `false` | **Dev**: log instead of sending WhatsApp/SMS. Refused in production |
| `SMS_PROVIDER` | no | `generic` | `msg91`, `twilio` or `generic`; missing credentials for the chosen one warn |
| `SMS_API_KEY`, `MSG91_TEMPLATE_DEFAULT`, `MSG91_TEMPLATE_BOOKING_CONFIRMATION`, `_REMINDER_24H`, `_REMINDER_15M`, `_RESCHEDULE`, `_CANCELLATION` | for msg91 | none | DLT-approved flow ids |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM` | for twilio | none | |
| `SMS_API_URL` | for generic | none | |

### Email
| Variable | Req | Default | Notes |
|---|---|---|---|
| `EMAIL_PROVIDER` | yes | `log` | `resend` or `postmark`. **`log` is Dev** (prints emails instead of sending); refused in production |
| `EMAIL_FROM` | yes | none | e.g. `Bookings <bookings@yourdomain.com>`; SPF and DKIM must be set up for the domain |
| `RESEND_API_KEY` / `POSTMARK_SERVER_TOKEN` | per provider | none | `POSTMARK_MESSAGE_STREAM` defaults to `outbound` |

### Product settings, monitoring and misc
| Variable | Req | Default | Notes |
|---|---|---|---|
| `READINESS_REQUIRED` | no | `google,payout` | Which connections an influencer needs before their page takes bookings |
| `READINESS_BYPASS` | no | `false` | **Dev**: skips the go-live checks. Refused in production |
| `ERROR_WEBHOOK_URL` | recommended | none | Every reported error is POSTed here (Slack/Discord compatible). Unset = a start-up warning |
| `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_SUPPORT_EMAIL` | no | `Session Automation`, `support@example.com` | **Build** time (also compiled into the SPA bundle) |
| `APP_LOCALE` | no | `en-IN` | Formatting of money and times. Also a **build** input of the SPA bundle |
| `ENABLE_DESIGN_PAGE` | no | `false` | Publishes the `/design` catalogue; warned about in production. Also a **build** input: the SPA only includes the page when built with `true` |
| `SPA_GROUPS` | no | empty | Page groups served by the React SPA: empty (none, the old Next pages), `all`, or a comma list of `public,auth,booking,dashboard,admin`. Run time; unknown names are a start-up warning; with a group enabled the web process needs `web/dist/index.html` (section 3.2) |
| `SPA_API_TARGET` | no | `http://localhost:3000` | **Dev only**: where the Vite dev server (`npm run dev:web`) proxies `/api` |
| `ADMIN_PASSWORD` | no | generated | Read by `npm run admin:create` only |
| `SEED_DEMO_PASSWORD` | no | built-in | **Dev**: `npm run db:seed`. Never seed a production database |

### Deployment-only
| Variable | Where | Notes |
|---|---|---|
| `ALLOW_INSECURE_LOCAL_RUN` | docker-compose | **Dev**. See section 5 |
| `BUILD_STANDALONE` | Dockerfile build | `1` makes `next build` emit the standalone server |
| `PORT`, `HOSTNAME` | web container | `3000`, `0.0.0.0` (set in the Dockerfile) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | docker-compose | Local database credentials, defaults are local-only |

## 5. Start-up validation (`lib/env.ts`)

Configuration is validated once when each process starts: the web app from `instrumentation.ts` (`register()`), the worker
from the top of `worker/index.ts`. The pure function `validateEnv(env)` is unit-tested with injected environments
(`tests/env.test.ts`).

* **`NODE_ENV=production`**: any problem stops the process with one message listing every problem by variable name
  (never a value), e.g. `APP_SECRET: must be at least 32 characters in production`, and exit code 1. (The web app exits
  explicitly from `register()`: merely throwing there would leave Next.js serving every request with a 500.) A container
  that fails this crash-loops with the message in its log, so the rollout never goes healthy. Enforced:
  * `DATABASE_URL` set and a `postgres(ql)://` URL; `APP_URL` set and **https**; `APP_SECRET` 32+ characters;
    `TOKEN_ENCRYPTION_KEY` is 32 bytes of base64 (also `TOKEN_ENCRYPTION_KEY_PREVIOUS` when set); `REDIS_URL` set; the
    three `RAZORPAY_*` variables; a real `EMAIL_PROVIDER` with its key and `EMAIL_FROM`.
  * None of the development-only settings `EMAIL_PROVIDER=log`, `MESSAGING_DRY_RUN=true`, `WHATSAPP_DISABLED=true`,
    `READINESS_BYPASS=true`, `RATE_LIMIT_ENABLED=false`.
  * **No leading or trailing whitespace** in any variable the app reads. Values are used exactly as given, so
    `EMAIL_PROVIDER="resend\n"` (a pasted newline or a CRLF env file) would otherwise pass a lenient check and then make the
    email layer silently fall back to logging, dropping every email; a padded `APP_URL` builds broken links. The message
    names the variable and never shows the value.
  * Flags such as `RATE_LIMIT_ENABLED` must be spelled exactly `true`/`false`, because the code compares strings
    (`"False"` would leave limits on while looking like it turned them off).
* **Anything else** (development, test): the same kind of problem is printed as a warning and the process carries on.
  Production-only strictness is not applied.
* **Warnings in production** (the process still starts): `CLIENT_IP_HEADER` or `ERROR_WEBHOOK_URL` unset, Razorpay test key,
  `RATE_LIMIT_STORE=memory`, incomplete Google/SMS/WhatsApp-webhook configuration, `ENABLE_DESIGN_PAGE=true`, and
  `TOKEN_ENCRYPTION_KEY_PREVIOUS` still set (a rotation is unfinished).
* **Key fingerprint in the log.** Every web and worker process logs `[env] web: encryption key fingerprint 77710ab8` (plus
  `(previous key fingerprint ...)` during a rotation): the first 8 hex characters of a SHA-256 over the key, never the key.
  Compare it across instances (they must all match) and with the output of `keys:rotate` / `keys:verify` (section 9).
* **`ALLOW_INSECURE_LOCAL_RUN=true`** exists so the production containers can run on a laptop (`docker compose up`, the
  restore drill). It turns the five development-setting errors and the http `APP_URL` error into warnings, **only** when
  `APP_URL`'s host is `localhost`, `127.0.0.1` or `[::1]`. With a real hostname it is itself an error, so it cannot be left on
  by accident. Essentials (database, secrets, Redis, Razorpay) stay mandatory. (`NODE_ENV=development` is not an option for
  the Docker image: Next.js's standalone `server.js` runs in production mode.)
* `next build` does not validate (a build machine should not need production secrets), and `getConfig()` in `lib/env.ts` is
  a validated, cached, typed accessor for new code; secrets on it are non-enumerable so they never reach logs.

## 6. Release procedure

1. **Migrate first.** Run `prisma migrate deploy` (the tools image, or `npm run db:deploy`) against the production
   database and wait for it to finish. Migrations must be **backwards compatible with the version still running**
   (add columns/tables first; remove or rename in a later release), because old web and worker instances serve traffic
   while the rollout happens.
2. **Deploy web.** Roll instances one by one; the new instance must report `/api/ready` 200 before the old one is removed.
   A bad configuration fails fast at start-up (section 5) and the rollout stops with the old version still serving.
3. **Deploy worker.** Replace the worker(s) after web. `docker stop`/SIGTERM closes the queue workers cleanly; an in-flight
   job that is cut off is retried (jobs are idempotent and read current state). Job payloads must therefore stay
   backwards compatible for one release (add fields, do not rename them), because during the gap the old worker consumes
   what the new web enqueues.
4. **Verify**: `/api/ready` is 200, the admin console loads, place a test booking with Razorpay test keys on staging, and
   check the worker log shows `processing "meetings" queue`.
5. **Rollback**: redeploy the previous web and worker images. A migration is not rolled back automatically; this is why
   step 1 requires compatibility. To undo a bad schema change, ship a new forward migration. If only the React front end
   misbehaves, remove its page group from `SPA_GROUPS` and restart web: those pages are served by the old Next pages again,
   no deploy needed (section 3.2).

Back up first when the release contains a destructive migration (section 8).

## 7. Webhooks and callbacks to configure

| Provider | URL | Settings |
|---|---|---|
| Razorpay | `<APP_URL>/api/webhooks/payment` | Active events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Secret = `RAZORPAY_WEBHOOK_SECRET`. Signature is HMAC-SHA256 of the raw body (`X-Razorpay-Signature`); a failure inside the handler returns 500 so Razorpay retries (events are recorded in `webhook_events` for idempotency) |
| Meta / WhatsApp | `<APP_URL>/api/webhooks/whatsapp` | Callback verified with `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (GET handshake); deliveries signed with `WHATSAPP_APP_SECRET` or `META_APP_SECRET` (`X-Hub-Signature-256`). Subscribe the app to the `messages` field (delivery statuses) and `message_template_status_update`. The app is then subscribed to each influencer's WhatsApp Business Account when they connect (the result is recorded and shown in Settings); the worker also re-checks unapproved templates every 30 minutes, so a missing callback delays an approval but does not lose it |
| Google OAuth | `<APP_URL>/api/google/callback` | Authorised redirect URI, identical to `GOOGLE_REDIRECT_URI` |

Both webhook routes are exempt from the CSRF origin check and are authenticated by signature only; they are rate limited at
600/min per IP. Use the real public hostname: a tunnel URL that changes will silently stop payments being confirmed.

## 8. Backups, point-in-time recovery and the restore drill

Postgres holds everything that cannot be recreated (customers, bookings, payments, payout ledger, audit log, encrypted
tokens). Redis holds in-flight jobs (see the runbook for what is and is not recoverable if it is lost).

**Checklist**
- [ ] Automated daily backups are on, with retention of at least 14 days (30 recommended)
- [ ] **Point-in-time recovery** (continuous WAL archiving) is on, so the recovery point is minutes, not a day.
      Managed Postgres usually sells this as a paid add-on (for Supabase it is a paid add-on **(not verified)**)
- [ ] Backups live in a different failure domain than the database (other region/account), and access is restricted and logged
- [ ] The **encryption keys are backed up separately from the database** (section 9). A database backup restored without
      `TOKEN_ENCRYPTION_KEY` cannot decrypt Google tokens, payout details or WhatsApp tokens
- [ ] Old encryption keys are retained for as long as any backup that was encrypted with them is retained
- [ ] Redis persistence is on (AOF), `noeviction` is set
- [ ] RPO and RTO targets are written down (suggested: RPO <= 15 minutes with PITR, RTO <= 2 hours)
- [ ] Someone other than the person who set it up has done the drill below

**Restore drill (quarterly, and before launch).** Never restore over production; restore next to it. The checks that
matter most need no running app at all: steps 3 and 4.
1. Restore the latest backup, or PITR to a timestamp a few minutes ago, into a **new** database instance. Note the time taken.
2. Write a drill environment file **outside the repository** (for example `~/secrets/drill.env`): a copy of production's
   with these changes. `DATABASE_URL` points at the restored instance. `TOKEN_ENCRYPTION_KEY` is production's key, and
   `TOKEN_ENCRYPTION_KEY_PREVIOUS` is the old key too if you are restoring a backup older than a key rotation (or if a
   rotation is unfinished). `REDIS_URL` points at a throwaway Redis (`docker run -d -p 127.0.0.1:56379:6379 redis:7-alpine`),
   never production's. Razorpay **test** keys. No provider API keys. Then add the local-run switches:
   `ALLOW_INSECURE_LOCAL_RUN=true`, `APP_URL=http://localhost:3300`, `EMAIL_PROVIDER=log`. Section 5 explains why: the
   Docker image always runs in production mode, which refuses `EMAIL_PROVIDER=log`, except under this documented switch,
   which is honoured only for a `localhost` `APP_URL`. Run **no worker**: a worker on a restored copy would send real
   messages and create real meetings for restored bookings. With `EMAIL_PROVIDER=log` the web process prints emails
   instead of sending them, so nothing reaches a real customer.
3. Schema: `docker run --rm --env-file ~/secrets/drill.env sessions-tools npx prisma migrate status` (nothing pending).
4. Keys: `docker run --rm --env-file ~/secrets/drill.env sessions-tools npm run keys:verify -- --allow-previous`. It
   decrypts every encrypted column (Google tokens, payout details, WhatsApp tokens) and exits 0 only if each value reads with
   `TOKEN_ENCRYPTION_KEY` or `TOKEN_ENCRYPTION_KEY_PREVIOUS`; a non-zero exit means the key you hold is not the key those
   values were written with, i.e. the backup is not usable in a real recovery. This replaces any need to guess.
5. App smoke test (optional): `docker run -d --name drill-web -p 127.0.0.1:3300:3000 --env-file ~/secrets/drill.env sessions-web`,
   then `curl http://127.0.0.1:3300/api/ready` is 200. (From Docker Desktop, reach a database on the host as
   `host.docker.internal`.) Log in as a test influencer, open the dashboard; open Payments in the admin console.
6. Compare row counts of `bookings`, `payments`, `payouts` and the newest `created_at` with production.
7. Record backup time, restore duration, anything that surprised you. Then `docker rm -f drill-web`, delete the restored
   instance, the throwaway Redis and `~/secrets/drill.env`.

## 9. Secrets and encryption-key rotation

**Where secrets live**: the platform's secret store (Vercel environment variables, your container host's secrets, a cloud
secret manager), injected as environment variables at run time. `.env` is for local development, is git-ignored and is
never copied into an image. Give the web and worker only what they use; the tools image (migrate, keys:rotate) gets its own
environment when run. Keep an offline, access-controlled copy of `TOKEN_ENCRYPTION_KEY`, `APP_SECRET` and the Razorpay
secrets in the company password manager.

**If `TOKEN_ENCRYPTION_KEY` is lost** the encrypted values cannot be read. It is recoverable but disruptive: influencers
reconnect Google, reconnect WhatsApp and re-enter payout details (the table stores only masked values beside the
ciphertext), and bookings that were waiting on a Meet link wait until they do.

**What is encrypted.** The rotation and verification tools cover every column in this table, and a test
(`tests/key-rotation.test.ts`) discovers every `*_enc` / `*Enc` column in `prisma/schema.prisma` and fails if one is
missing from the list in `lib/key-rotation-db.ts`, so a new encrypted column cannot be forgotten. Each entry names the
table, column, the column its AAD is derived from (`ownerColumn`) and the AAD function:

| Column | AAD |
|---|---|
| `google_tokens.refresh_token_enc` | influencer id |
| `payout_accounts.account_number_enc` | `payout:<influencerId>:account` |
| `payout_accounts.upi_id_enc` | `payout:<influencerId>:upi` |
| `whatsapp_connections.token_enc` | `whatsapp:<influencerId>` |
| `whatsapp_registration_pins.pin_enc` | `whatsapp-pin-number:<phoneNumberId>` (the two-step PIN belongs to the number, so this row outlives a disconnect) |
| `whatsapp_connections.registration_pin_enc` | `whatsapp-pin:<influencerId>` (superseded; still rotated, and read once if it holds a PIN) |

**How the keys behave**: new values are always encrypted with `TOKEN_ENCRYPTION_KEY`. Decryption tries that key, then
`TOKEN_ENCRYPTION_KEY_PREVIOUS` if set. A wrong key or wrong AAD fails GCM authentication and throws.

**Fingerprints.** A key fingerprint is the first 8 hex characters of a SHA-256 over the key. It is safe to print, log and
paste into a ticket, and it tells two keys apart. Every web and worker process logs its current (and previous) key
fingerprint at start-up, and both key tools print the fingerprints of the keys in *their* environment first. The tools exist
to move data between two keys, but they cannot know which key your services consider right: a wrong key encrypts and
decrypts consistently, so a self-check would pass. The fingerprints are how a human closes that gap.

**The key tools** (run them with the **same environment as the running services**, never with hand-assembled keys). They read
the app's own variables, `TOKEN_ENCRYPTION_KEY` = the key values must end up on (the new key) and
`TOKEN_ENCRYPTION_KEY_PREVIOUS` = the key they are on today (the old key):

* `npm run keys:verify [-- --allow-previous] [--only-owner <id>]`: decrypt-only. Reports, per column, how many values decrypt
  with the **current** key, how many only with the previous key, and how many with neither. Exit 0 only if every value
  decrypts with the current key (`--allow-previous` also accepts previous-key values; the restore drill uses it). Exit 1
  otherwise, 2 for bad usage or configuration. It never writes and takes no row locks.
* `npm run keys:rotate [-- --dry-run | --apply --confirm-new-fingerprint=<8 hex>] [--only-owner <id>]`: dry run is the
  default. `--apply` is refused (exit 2, nothing read or written, no database connection opened) unless
  `--confirm-new-fingerprint` equals the fingerprint of `TOKEN_ENCRYPTION_KEY` in the tool's environment. Take that value
  from your **running services' start-up log**, not from the tool's own output, so a wrong environment cannot be applied by
  accident. Passing the flag to a dry run checks the environment early (a mismatch stops it). Each row is locked,
  re-encrypted, **decrypted again and compared with the plaintext before it is written** (this catches a bug or a damaged
  value; it cannot, and does not claim to, tell whether the key is the one your services use), and committed in its own
  transaction, so an interruption leaves every row on the old key or the new key, never half-written. `updated_at` is not
  touched, a row already readable with the new key is skipped (re-running is safe), and a row that neither key can read is
  left unchanged and counted. Output is counts and row ids, never values or keys. Exit 0 ok, 1 a row failed, 2 usage.
  `--only-owner <id>` (repeatable) restricts a run to some owners, for a canary.

**Rotation procedure** (do it when a key may have been exposed, when someone with access leaves, or on your schedule;
takes minutes, no downtime). `<env>` below means "the environment the services run with", for example
`--env-file ~/secrets/sessions-prod.env` or your platform's one-off-job feature (section 3).

1. **Prepare.** Generate the new key (`openssl rand -base64 32`) and store it in the secret manager under a new name. Take a
   database backup. Note the old key's fingerprint from the current service logs (`encryption key fingerprint ...`).
2. **Deploy the keys to the running services**: `TOKEN_ENCRYPTION_KEY=<NEW>` and `TOKEN_ENCRYPTION_KEY_PREVIOUS=<OLD>` on both
   web and worker. From now on new writes use the new key and every old row is still readable. In each instance's
   start-up log check `encryption key fingerprint X (previous key fingerprint Y)`: X must be the same everywhere and
   match the fingerprint of the new key in your secret manager, Y the old key's. Write X down.
   *Strict variant, if you cannot tolerate even a transient error during the rollout* (these values change a handful of
   times a day at most, a Google connect or a payout edit): first deploy `TOKEN_ENCRYPTION_KEY=<OLD>` +
   `TOKEN_ENCRYPTION_KEY_PREVIOUS=<NEW>` so every instance can read both, and only then flip the two. Do not run the tools
   until after the flip.
3. **Dry run** with the services' environment: `docker run --rm <env> sessions-tools npm run keys:rotate`. Check the two
   fingerprints printed at the top are X and Y, that "would rotate" is the number of values you expect, and `failed 0`.
4. *(Optional canary)* `... npm run keys:rotate -- --apply --confirm-new-fingerprint=X --only-owner <influencerId>`, then use
   that influencer's account (reconnect-free: a booking that reads their Google token, the payout reveal).
5. **Apply**: `... npm run keys:rotate -- --apply --confirm-new-fingerprint=X`. If the fingerprint does not match the
   tool's environment it refuses and changes nothing.
6. **Verify**: `docker run --rm <env> sessions-tools npm run keys:verify` must print `N of N encrypted value(s) decrypt with
   the current key` and exit 0. A re-run of `keys:rotate` reports `already on new key` for every row. Spot-check in the app
   (admin payout reveal; a new booking for a connected influencer).
7. **Finish**: remove `TOKEN_ENCRYPTION_KEY_PREVIOUS` from web and worker, redeploy, confirm the start-up log no longer shows a
   previous fingerprint, and run `keys:verify` once more with the new environment (exit 0, now without the old key). Keep the
   old key archived until the last database backup that predates the rotation has expired: restoring such a backup needs it
   as `TOKEN_ENCRYPTION_KEY_PREVIOUS` (`keys:verify --allow-previous` in the restore drill checks exactly that).

*Rollback* before step 7: put the keys back (`TOKEN_ENCRYPTION_KEY=<OLD>`, `TOKEN_ENCRYPTION_KEY_PREVIOUS=<NEW>`) on the
services **and** in the tool's environment, check the start-up fingerprint is the old key's, then run the same `--apply
--confirm-new-fingerprint=<old key's fingerprint>`. The tools never need the app to be stopped.

*Mistakes the guard exists for.* The services run key A but the shell used for the tool holds key B: the tool prints B's
fingerprint, and since you confirm with A's (from the service log) it refuses. The two variables swapped
(current = old): same refusal. A leftover `TOKEN_ENCRYPTION_KEY_NEW` from an older version of this document is ignored.

Other secrets: `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` rotate in the Razorpay dashboard and the environment at
the same moment (payments fail between the two changes, so do it in a quiet period); `APP_SECRET` has no overlap window, so
changing it invalidates every emailed manage/pay link and any in-flight Google connect; OAuth client secrets rotate in
Google Cloud Console; per-influencer WhatsApp tokens are replaced by the influencer in Settings.

## 10. Razorpay live-mode go-live checklist

- [ ] Razorpay account activation (KYC, bank account, business details) is complete and live mode is enabled
- [ ] Live **Key Id/Secret** generated and set as `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` on web and worker; no `rzp_test_` key remains
      (the start-up check warns about test keys)
- [ ] A **live-mode** webhook (live and test have separate webhook configurations) pointing at `<APP_URL>/api/webhooks/payment`
      with the five events from section 7 and a new, random `RAZORPAY_WEBHOOK_SECRET`
- [ ] Payment methods you want (UPI, cards, netbanking) are enabled in the dashboard; the website URL and policies pages
      (`/terms`, `/privacy`, `/refund-policy`, `/contact`) are published, which Razorpay checks during activation
- [ ] `AUTO_REFUND_ON_CANCEL` decided on purpose; `PAYOUT_HOLD_DAYS` and `PLATFORM_FEE_BPS` set
- [ ] One real low-value payment end to end on production: booking, webhook received (check `webhook_events`), booking
      `SCHEDULED`, Meet link, confirmation. Then refund it from the dashboard and confirm `refund.processed` arrives
- [ ] Admin: run **Reconcile with Razorpay** and confirm the live payment reconciles
- [ ] Alerting on webhook failures is on (the Razorpay dashboard shows failed deliveries; section 12)
- [ ] Settlement account and settlement schedule are what you expect; the person who pays influencers knows the manual process
      (README, "Reconciliation and influencer payouts")
- [ ] Tax invoicing / GST handling for the platform fee is decided with your accountant **(outside this codebase, not verified)**

## 11. Google OAuth verification

Meet links are created on each influencer's own Google Calendar through OAuth, with the scopes in `lib/google.ts`:
`calendar.events` (sensitive), `gmail.send` (**restricted**, unless `GOOGLE_REQUEST_GMAIL_SEND=false`) and `openid email`.

- **Enable the APIs, not just the scopes.** In the Cloud project open APIs & Services > Library and enable the
  **Google Calendar API** and, unless `GOOGLE_REQUEST_GMAIL_SEND=false`, the **Gmail API**. They are separate switches. With
  the Gmail API off, every send answers 403 `accessNotConfigured`, every customer email silently goes out from the platform
  address instead (influencer as Reply-To), and only two signs remain: the Google panel in Settings shows "Gmail not
  working", and the web/worker log has one `Gmail sending is not working for influencer ...` line per influencer per hour
  with Google's reason. Check it after the first real customer email of a new deployment.
- The worker checks every connected Google account once a day and two minutes after it starts (`worker/google-health.ts`,
  log lines `[worker] google health:`). A grant Google reports as revoked or expired is flagged "Reconnect needed" (the
  booking page goes offline, one alert email to the influencer); network errors, Google outages and a wrong
  `GOOGLE_CLIENT_SECRET` are logged as `could not check N of N connection(s)` and never disconnect anyone. This is what
  catches the 7-day expiry below before a paying customer does.
- While the consent screen is in **Testing**, only listed test users can connect and **refresh tokens expire after 7 days**,
  so every influencer would have to reconnect weekly. Publish the app to **In production** before launch.
- `calendar.events` needs Google's OAuth verification (a privacy policy URL, a verified domain, a demo video of the scope
  being used). Start early: it takes days to weeks.
- `gmail.send` is restricted and is normally subject to an additional third-party security assessment. Until that is
  done, set `GOOGLE_REQUEST_GMAIL_SEND=false` so only Calendar is requested; customers then get email from the platform
  address with the influencer as Reply-To (the code already falls back this way).
- Unverified apps show Google's "unverified app" warning and are capped at 100 users.
- `GOOGLE_REDIRECT_URI` must be the production URL and be listed on the OAuth client.

## 12. Monitoring and alerts

Send logs somewhere searchable and alert on **absence and failure**. Suggested alerts, with severity:

| Signal | Source | Alert when |
|---|---|---|
| Web readiness | Uptime monitor on `/api/ready` (and `/api/health`) from outside | Failing for 2+ minutes (page) |
| 5xx rate on web | Platform metrics / log search | Above 2% for 5 minutes |
| **Payment webhook** failing | Razorpay dashboard failed-delivery alerts; log line `[webhook] failed` | Any sustained failure (page): customers pay but are not confirmed |
| **Worker down** | Container health (`scripts/worker-healthcheck.ts`), platform restart count, or BullMQ `queue.getWorkers()` | Unhealthy for 5 minutes (page); no `[worker]` log output at all |
| Queue backlog / failures | BullMQ queue counts (`meetings`, `messages`, `reminders`): `waiting` age, `failed` count | Jobs waiting > 5 minutes, or any job in `failed` |
| Paid bookings stuck | Admin console, Payments "captured but booking not paid"; log `[worker] create-meeting gave up` | Any item older than 15 minutes |
| Refunds needed | Admin console, Payments "needs refund" (`Payment.needsRefund`) | Any item; a human has to act |
| Database connections | Provider metrics; app errors `timeout exceeded when trying to connect` | Connections > 80% of the limit, or any pool timeout |
| Database health | Provider: CPU, storage, replication lag, backup job status | Storage > 80%, last backup failed or older than 26 hours |
| Redis | Memory use vs limit, `evicted_keys`, persistence status, connection count | Memory > 80%, any eviction (must stay 0), persistence errors |
| Rate limiting | Log line `[rate-limit] 429 ...`, `[rate-limit] Redis unavailable, using Postgres` | Sudden spike (attack or misconfigured `CLIENT_IP_HEADER`); Redis failover persisting |
| Application errors | `ERROR_WEBHOOK_URL` messages (`where` field names the module), `worker:expire-holds`, `worker:sweep` | Any (route to a channel someone reads) |
| Start-up validation | Container exits with `[env] ... will not start` | Any (a failed rollout) |
| Encryption key identity | Start-up log line `encryption key fingerprint <8 hex>` of every web and worker instance | Instances disagree, the fingerprint differs from the one recorded for the key in the secret manager, or a `previous key fingerprint` is still logged after a rotation should have finished |
| TLS / domain | Certificate and domain expiry monitor | 14 days before |
| Google reconnects | Dashboard "Reconnect needed", alert emails to influencers, worker log `[worker] google health:` | Many at once (suggests a client-secret or consent-screen problem); `could not check N of N` (our credentials or Google, not the influencers) |
| Gmail sending | Log line `Gmail sending is not working for influencer` (hourly per influencer), Google panel "Gmail not working" | Any, for more than one influencer (the Gmail API is probably not enabled on the project) |

`GET /api/ready` logs are throttled (one line per minute per failing check), so a probe every few seconds will not flood
the log.

## 13. Incident runbook

First: `curl -s https://<host>/api/ready` tells you which dependency is failing. Customer-facing impact and recovery per
failure:

**Payment webhook failing (customers pay, booking stays `PENDING_PAYMENT`)**
1. Razorpay dashboard > Webhooks: look at recent deliveries and the response code. 401 = secret mismatch
   (`RAZORPAY_WEBHOOK_SECRET` differs from the dashboard); 5xx/timeouts = app or database problem (see below); no deliveries = wrong URL or webhook disabled.
2. Fix the cause. Razorpay retries failed deliveries for a period (documented as up to 24 hours **(not verified here)**);
   the handler is idempotent (`webhook_events`), so retries and manual re-sends are safe.
3. Afterwards, admin console > Payments > "captured but booking not paid": anything left there paid but is not confirmed.
   Late payments whose slot was retaken are flagged `needsRefund`; refund them. Use **Reconcile with Razorpay** to compare.

**Worker down (no Meet links, messages or reminders; bookings sit in `PAID`)**
1. Restart it; check logs for `[env] worker will not start` (configuration), Redis or database connection errors.
2. On start the worker re-queues every `PAID` booking without a meeting (`requeuePendingMeetings`), expires stale holds and
   resumes the queues, so a short outage self-heals. Jobs that were waiting in Redis are processed in order.
3. Delayed jobs that came due while the worker was down run as soon as it is back, **however late**: the reminder handler
   only checks that the booking is still `SCHEDULED` and its time is unchanged, so a "15 minutes before" reminder can
   arrive after the session has started. Check the dashboard's needs-attention list for failed messages, and contact
   customers whose session was affected.
4. Availability and payments are unaffected meanwhile (section 1).

**Redis down (queues unavailable)**
1. Web keeps serving: rate limits fail over to Postgres. But **checkout confirmation enqueues** a job inside the webhook
   transaction, so the payment webhook returns 500 while Redis is down and Razorpay will retry. Restore Redis and let the
   retries land; nothing is lost or double-processed.
2. If Redis was **lost or flushed** (not just unreachable), jobs in it are gone. The worker's start-up re-queue recovers
   paid bookings without a meeting, but **nothing rebuilds scheduled reminders or unsent confirmation messages**
   (reminders are delayed BullMQ jobs created when the meeting is). After a data loss: restart the worker (recovers meetings),
   then review upcoming `SCHEDULED` sessions and use the dashboard's resend to re-send confirmations; reminders for those
   sessions will not fire unless the booking is rescheduled. This is why Redis needs persistence (section 2).

**Database pool exhausted (`timeout exceeded when trying to connect`, `/api/ready` 503 with `db: fail`, 500s)**
1. Check provider connection count against `DATABASE_POOL_MAX x (web instances + worker replicas)`. Over the limit is the
   usual cause after scaling out; reduce `DATABASE_POOL_MAX` or the instance count, or raise the plan.
2. Look for a slow query holding connections (provider dashboard: long-running statements); statements are cancelled after
   `DATABASE_STATEMENT_TIMEOUT_MS` (15 s default).
3. Requests wait up to `DATABASE_CONNECT_TIMEOUT_MS` (10 s) for a connection and then fail, which sheds load instead of
   queueing forever. Restarting the web instances frees leaked connections. Health (`/api/health`) stays green throughout,
   by design, so instances are not killed; readiness takes them out of rotation.

**Bad deploy (everything 500s or instances will not start)**: roll back to the previous images (section 6). A configuration
error shows up as `[env] web will not start` followed by the list of variable names.

## 14. Dependency audit (`npm audit --omit=dev`)

`npm audit` reported 4 high findings, all arriving through the Prisma **CLI** package (`prisma`, a dev dependency):

| Advisory | Package | Path |
|---|---|---|
| GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3 | `mysql2` <= 3.23.0 (pinned `3.15.3` by `prisma@7.10.0`) | `prisma` > `mysql2` |
| GHSA-ggr8-5vv4-36mx | `deepmerge-ts` < 8 (`7.1.5`) | `prisma` > `@prisma/config` > `deepmerge-ts` |

**Reachability: not reachable by the application at run time.** The app uses Postgres through `@prisma/adapter-pg` and `pg`.
The only code in the dependency tree that loads `mysql2` is `prisma/build/cli.js` (the Prisma CLI, for MySQL introspection
and Studio); nothing under `@prisma/client`, `@prisma/adapter-pg`, `generated/prisma`, `lib/`, `app/` or the built `.next`
output references it, and `deepmerge-ts` is imported only by `@prisma/config`, which merges the contents of
`prisma.config.ts` when the CLI runs. Neither processes network or user input. They appear in `--omit=dev` reports only
because `@prisma/client` declares `prisma` as an *optional peer* dependency, which makes npm keep it (and its tree) in
production installs; they are therefore also on disk in the worker and tools images, where an image scanner would report them.

**Fix applied**: `package.json` `overrides` pin `mysql2` to `^3.24.5` (same major, a minor-version bump) and `deepmerge-ts` to
`^8.0.2` (a major bump of a library used only through its `deepmerge` function by the Prisma config loader). `npm audit` now
reports 0 vulnerabilities. Verified: `npx prisma generate`, `prisma validate`, `prisma migrate diff`, `prisma migrate deploy`
(in the tools image), `tsc --noEmit` and `npm run build`. The suggested `npm audit fix --force` would downgrade to
`prisma@6.19.3`, a breaking change that is unnecessary here. **Remove the overrides when Prisma ships releases that depend on
patched versions** (check on each Prisma upgrade); until then they are the supported-by-npm way to carry a patched
transitive dependency, at the cost of running Prisma's tooling against dependency versions it was not released with.

`tsx` moved from `devDependencies` to `dependencies`, because the worker (`npm run worker`) and the operational scripts run
under it in production. `.github/dependabot.yml` raises weekly grouped npm updates and monthly GitHub Actions and Docker
base-image updates, and CI runs `npm audit --omit=dev --audit-level=high` as an advisory step (`continue-on-error`) so a new
finding is visible on every run without blocking unrelated work. `engines.node` is `>=22` and `.nvmrc` pins 22.

## 15. Verified when this was written, and known gaps

**Verified** (Docker 29, Windows host, 10 Oct 2026): all three images build; the web image exits 1 with the aggregated
message when started without configuration; `docker compose up --build` brings up Postgres, Redis, the migration job (all
migrations applied with the patched `mysql2`/`deepmerge-ts`), web and worker, all reporting healthy; `/api/health` stays
200 and `/api/ready` turns 503 naming `db` or `redis` when Postgres or Redis is stopped, and recovers when they return;
the worker logs all three queues and `scripts/worker-healthcheck.ts` passes against a real Redis. Image sizes on disk:
web about 420 MB, worker about 830 MB, tools about 1.7 GB.

The key tools were run end to end (the real scripts, a real Postgres in a throwaway container, throwaway keys, never a
shared database): `keys:verify` on a fresh database, mid-rotation (exit 1) and with `--allow-previous` (exit 0); `keys:rotate`
as a dry run, refused without or with a wrong `--confirm-new-fingerprint` (exit 2, state unchanged), refused when the
shell holds a different "new" key than the services (exit 2), applied with the right fingerprint, idempotent when repeated,
and `keys:verify` clean afterwards with and without `TOKEN_ENCRYPTION_KEY_PREVIOUS`. The restore drill in section 8 was
replayed as written (migrate status, `keys:verify --allow-previous`, the web image with `ALLOW_INSECURE_LOCAL_RUN` ready on
200 and logging the same key fingerprints the tool printed); the same environment without the switch exits 1 on
`EMAIL_PROVIDER=log`, and so does `NODE_ENV=development` passed to the image.
**Not verified**: a deployment on a real host (Vercel, Fly.io, Kubernetes, ...), Upstash/Supabase specifics marked above,
Razorpay's retry window, and the Google/Meta consent-screen requirements beyond what the code requests.

**Known gaps**

- Scheduled reminders live only in Redis; nothing reconstructs them from the database after a Redis data loss (section 13).
  A worker start-up reconciliation of `SCHEDULED` bookings would close this.
- `scripts/worker-healthcheck.ts` cannot say *which* replica is missing and needs a Redis that allows `CLIENT LIST`
  **(not verified on Upstash)**; use the platform's own restart signal if it does not.
- Migrations use the single `DATABASE_URL`; a separate `DIRECT_URL` for migrations behind a transaction pooler is not supported yet.
- `APP_SECRET` has no previous-key fallback (unlike the encryption key).
- Hosting-specific manifests (Vercel project settings, Kubernetes, Fly.io, ...) are not included; the Dockerfiles and
  this document are the contract.
- The Docker build and the compose stack are exercised in CI only as image builds and a smoke test (`.github/workflows/ci.yml`).

## 16. Upgrade notes

Read this before deploying this version to an installation that is already running.

1. **`APP_SECRET` must be at least 32 characters in production.** The code still works with 16, and development only
   warns, but production start-up now refuses anything shorter, so an installation that was set up with a 16-31 character
   secret **will not start** until it is replaced. `APP_SECRET` has **no previous-secret fallback** (unlike the encryption
   key): once you change it, every link signed with the old one stops working. That covers customers' emailed
   manage/cancel/reschedule and pay links (`lib/self-service.ts`), the status polling of a booking that is being paid right
   now, and any Google connection flow in progress (`app/api/google/connect`). Logins are not affected (sessions are opaque
   database tokens, not signed with it). Plan for it: replace it during a quiet period, set the new value on web and worker
   together, tell support that older links must be re-sent, and generate it with `openssl rand -base64 32`.
2. **New production requirements** (previously only recommended): https `APP_URL`, `REDIS_URL`, the three `RAZORPAY_*`
   variables, a real `EMAIL_PROVIDER` with its key and `EMAIL_FROM`, none of `MESSAGING_DRY_RUN` / `WHATSAPP_DISABLED` /
   `READINESS_BYPASS` / `RATE_LIMIT_ENABLED=false`, and no leading or trailing whitespace in any variable. The app prints
   every problem at once and exits, so try the new image on staging first and read the list.
3. **Key rotation variables.** `TOKEN_ENCRYPTION_KEY_PREVIOUS` is the only extra variable; the tools read the services' own
   `TOKEN_ENCRYPTION_KEY` / `TOKEN_ENCRYPTION_KEY_PREVIOUS`. There is no `TOKEN_ENCRYPTION_KEY_NEW`.
4. **Runtime**: Node 22+ (`engines`, `.nvmrc`), `tsx` is now a production dependency, and `package.json` carries `overrides`
   for two Prisma tooling dependencies (section 14). No database migration is part of this change.
5. **Health checks**: point the load balancer at `/api/ready` and the process supervisor at `/api/health` (section 3.1).
