import { z } from "zod";
import { keyFingerprint, parseKeyBytes } from "./crypto";

/**
 * Start-up configuration validation.
 *
 * `validateEnv(env)` is a pure function over an env record (no logging, no process access), so it is unit-tested
 * with injected objects. The rest of the module wires it into the processes:
 *   - web app:  instrumentation.ts calls `initEnv("web")` once when the server starts
 *   - worker:   worker/index.ts calls `initEnvOrExit("worker")` first thing
 *   - code that wants typed settings calls `getConfig()` (validated once, then cached)
 *
 * Behaviour:
 *   - NODE_ENV=production: any problem below stops the process with ONE aggregated message that lists every
 *     problem by variable name. The message never contains a value, so it is safe to put in logs.
 *   - anything else (development, test): the same problems that would break the app are logged as warnings and the
 *     process carries on. Production-only strictness (https, real email provider, Razorpay keys, ...) is not
 *     enforced in development, where `.env.example` deliberately uses dev-only settings.
 *
 * Settings that exist only for development (EMAIL_PROVIDER=log, MESSAGING_DRY_RUN=true, WHATSAPP_DISABLED=true,
 * READINESS_BYPASS=true, RATE_LIMIT_ENABLED=false) are refused in production, because each one silently disables
 * something that real customers depend on (emails, messages, go-live checks, abuse protection).
 *
 * Values are never trimmed: the code reads `process.env` exactly as given, so in production a variable with leading
 * or trailing whitespace is rejected by name (its value is never printed).
 *
 * The one escape hatch is ALLOW_INSECURE_LOCAL_RUN=true, for running the production containers on your own machine
 * (docker-compose.yml). It is honoured ONLY when APP_URL points at localhost / 127.0.0.1 / [::1], and it turns
 * the dev-only-setting errors above into warnings. A real deployment has a public https APP_URL, so the flag is an
 * error there rather than being silently ignored.
 */

export type EnvRecord = Record<string, string | undefined>;

export interface EnvReport {
  production: boolean;
  /** True when the local-run escape hatch is active. */
  localRun: boolean;
  /** Problems that stop a production start. Always empty outside production. */
  errors: string[];
  /** Everything else worth knowing; also holds the downgraded problems outside production. */
  warnings: string[];
  /** Best-effort typed settings. Fields are undefined where the input was missing or malformed. */
  config: AppConfig;
}

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  /** APP_URL without a trailing slash (http://localhost:3000 when unset, as lib/brand.ts does). */
  appUrl: string;
  database: { poolMax: number; statementTimeoutMs: number; connectTimeoutMs: number; idleTimeoutMs: number };
  redisConfigured: boolean;
  /** Fingerprints (8 hex characters of a hash, safe to log) of the encryption keys; see keyFingerprint in lib/crypto.ts. */
  encryption: { fingerprint: string | undefined; previousFingerprint: string | undefined };
  rateLimit: { enabled: boolean; store: "auto" | "redis" | "postgres" | "memory"; multiplier: number };
  email: { provider: "log" | "resend" | "postmark" };
  sms: { provider: "msg91" | "twilio" | "generic" };
  messagingDryRun: boolean;
  readinessBypass: boolean;
  razorpay: { keyId: string | undefined; testMode: boolean };
  clientIpHeader: string | undefined;
  /**
   * Secret values. Non-enumerable on purpose, so JSON.stringify(config), console.log(config) and object spreads
   * never include them by accident.
   */
  readonly secrets: {
    databaseUrl: string | undefined;
    redisUrl: string | undefined;
    appSecret: string | undefined;
    tokenEncryptionKey: Buffer | undefined;
    tokenEncryptionKeyPrevious: Buffer | undefined;
    razorpayKeySecret: string | undefined;
    razorpayWebhookSecret: string | undefined;
  };
}

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment configuration: ${issues.length} problem${issues.length === 1 ? "" : "s"}\n` +
        issues.map((i) => `  - ${i}`).join("\n") +
        "\nFix these variables and restart (values are never printed). See doc/08-deployment.md.",
    );
    this.name = "EnvValidationError";
  }
}

/* ---------- schema ---------- */

const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const bool = (name: string) => z.enum(["true", "false"], { error: `${name} must be exactly "true" or "false"` }).transform((v) => v === "true");
const lowerEnum = <const T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(values, { error: `must be one of: ${label}` }));
const nonNegInt = z.string().regex(/^\d+$/, "must be a non-negative whole number").transform(Number);
const positiveNumber = z
  .string()
  .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, "must be a number greater than 0")
  .transform(Number);
const keyString = z.string().refine((v) => parseKeyBytes(v) !== null, "must be 32 bytes, base64 encoded (generate: openssl rand -base64 32)");

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, "must be a postgres:// or postgresql:// connection URL")
    .min(16, "is too short to be a real connection URL")
    .optional(),
  APP_URL: z.string().refine(isHttpUrl, "must be a valid http:// or https:// URL").optional(),
  REDIS_URL: z.string().regex(/^rediss?:\/\/.+/, "must be a redis:// or rediss:// URL").optional(),
  APP_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: keyString.optional(),
  TOKEN_ENCRYPTION_KEY_PREVIOUS: keyString.optional(),

  EMAIL_PROVIDER: lowerEnum(["log", "resend", "postmark"], "resend, postmark, log").optional(),
  SMS_PROVIDER: lowerEnum(["msg91", "twilio", "generic"], "msg91, twilio, generic").optional(),
  RATE_LIMIT_STORE: lowerEnum(["auto", "redis", "postgres", "memory"], "auto, redis, postgres, memory").optional(),
  RATE_LIMIT_MULTIPLIER: positiveNumber.optional(),

  RATE_LIMIT_ENABLED: bool("RATE_LIMIT_ENABLED").optional(),
  MESSAGING_DRY_RUN: bool("MESSAGING_DRY_RUN").optional(),
  READINESS_BYPASS: bool("READINESS_BYPASS").optional(),
  WHATSAPP_DISABLED: bool("WHATSAPP_DISABLED").optional(),
  WHATSAPP_PLATFORM_FALLBACK: bool("WHATSAPP_PLATFORM_FALLBACK").optional(),
  AUTO_REFUND_ON_CANCEL: bool("AUTO_REFUND_ON_CANCEL").optional(),
  GOOGLE_REQUEST_GMAIL_SEND: bool("GOOGLE_REQUEST_GMAIL_SEND").optional(),
  ENABLE_DESIGN_PAGE: bool("ENABLE_DESIGN_PAGE").optional(),
  ALLOW_INSECURE_LOCAL_RUN: bool("ALLOW_INSECURE_LOCAL_RUN").optional(),

  DATABASE_POOL_MAX: nonNegInt.optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: nonNegInt.optional(),
  DATABASE_CONNECT_TIMEOUT_MS: nonNegInt.optional(),
  DATABASE_IDLE_TIMEOUT_MS: nonNegInt.optional(),
  PAYOUT_HOLD_DAYS: nonNegInt.optional(),
  PLATFORM_FEE_BPS: nonNegInt.optional(),

  READINESS_REQUIRED: z
    .string()
    .refine(
      (v) => v.split(",").every((t) => ["google", "gmail", "whatsapp", "payout", ""].includes(t.trim().toLowerCase())),
      "may only list: google, gmail, whatsapp, payout",
    )
    .optional(),
});

type ParsedEnv = z.infer<typeof envSchema>;

/**
 * Every variable this app reads (the names in .env.example plus a few others). In production a value with leading or
 * trailing whitespace is REJECTED rather than trimmed, because the code reads `process.env` exactly as given: an
 * `EMAIL_PROVIDER` of "resend\n" passes a trimmed check and then silently falls back to logging every email, and a
 * padded `APP_URL` builds broken links. A test keeps this list in step with .env.example.
 */
export const KNOWN_ENV_VARS = [
  "NODE_ENV", "DATABASE_URL", "DATABASE_POOL_MAX", "DATABASE_STATEMENT_TIMEOUT_MS", "DATABASE_CONNECT_TIMEOUT_MS", "DATABASE_IDLE_TIMEOUT_MS",
  "APP_URL", "APP_SECRET", "APP_LOCALE", "TOKEN_ENCRYPTION_KEY", "TOKEN_ENCRYPTION_KEY_PREVIOUS", "REDIS_URL",
  "RATE_LIMIT_STORE", "RATE_LIMIT_ENABLED", "RATE_LIMIT_MULTIPLIER", "CLIENT_IP_HEADER",
  "NEXT_PUBLIC_BRAND_NAME", "NEXT_PUBLIC_SUPPORT_EMAIL",
  "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "AUTO_REFUND_ON_CANCEL",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_REQUEST_GMAIL_SEND",
  "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_TEMPLATE_LANGUAGE",
  "WHATSAPP_DISABLED", "WHATSAPP_PLATFORM_FALLBACK", "WHATSAPP_REGISTRATION_PIN", "META_APP_ID", "META_APP_SECRET", "META_ES_CONFIG_ID",
  "MESSAGING_DRY_RUN", "SMS_PROVIDER", "SMS_API_KEY", "SMS_API_URL",
  "MSG91_TEMPLATE_DEFAULT", "MSG91_TEMPLATE_BOOKING_CONFIRMATION", "MSG91_TEMPLATE_REMINDER_24H", "MSG91_TEMPLATE_REMINDER_15M",
  "MSG91_TEMPLATE_RESCHEDULE", "MSG91_TEMPLATE_CANCELLATION",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_FROM",
  "EMAIL_PROVIDER", "EMAIL_FROM", "RESEND_API_KEY", "POSTMARK_SERVER_TOKEN", "POSTMARK_MESSAGE_STREAM",
  "ERROR_WEBHOOK_URL", "ENABLE_DESIGN_PAGE", "PAYOUT_HOLD_DAYS", "PLATFORM_FEE_BPS",
  "READINESS_REQUIRED", "READINESS_BYPASS", "ALLOW_INSECURE_LOCAL_RUN",
  "PAYMENT_RECOVERY_ENABLED", "ADMIN_ALERT_EMAILS", "HEALTH_WORKER_STALE_SECONDS", "HEALTH_PAYMENT_UNRECOVERED_MINUTES",
  "HEALTH_MEETING_STUCK_MINUTES", "HEALTH_QUEUE_FAILED_MAX", "HEALTH_QUEUE_WAITING_MAX", "HEALTH_HOLD_SWEEP_GRACE_MINUTES",
  "HEALTH_RECOVERY_FAILING_RUNS", "HEALTH_RECOVERY_STALE_MINUTES", "HEALTH_ALERT_DEDUPE_MINUTES",
] as const;

/* ---------- helpers ---------- */

/**
 * Trims every value and treats blank values as unset, which is how `KEY=` lines in .env files behave in practice.
 * The checks run on this normalised view only to avoid piling up follow-on messages; padded values are reported
 * separately from the raw input (see KNOWN_ENV_VARS) and are fatal in production.
 */
function normalise(env: EnvRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const t = v?.trim();
    if (t) out[k] = t;
  }
  return out;
}

function keyFingerprintOf(raw: string | undefined): string | undefined {
  const key = parseKeyBytes(raw);
  return key ? keyFingerprint(key) : undefined;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function withSecrets(config: Omit<AppConfig, "secrets">, secrets: AppConfig["secrets"]): AppConfig {
  return Object.defineProperty(config, "secrets", { value: secrets, enumerable: false }) as AppConfig;
}

/* ---------- the validator ---------- */

/** Validates an env record. Pure: never throws, never logs, never reads process.env unless called with no argument. */
export function validateEnv(input: EnvRecord = process.env): EnvReport {
  const env = normalise(input);
  const production = env.NODE_ENV === "production";

  const errors: string[] = [];
  const warnings: string[] = [];
  /** Problems the app cannot run properly with: an error in production, a warning in development. */
  const essential = (variable: string, message: string) => (production ? errors : warnings).push(`${variable}: ${message}`);
  const warn = (variable: string, message: string) => warnings.push(`${variable}: ${message}`);

  // 0. Padding. The app reads values exactly as given, so a stray newline or space is a real difference, not noise.
  for (const name of KNOWN_ENV_VARS) {
    const raw = input[name];
    if (raw !== undefined && raw !== "" && raw !== raw.trim()) {
      essential(name, "has leading or trailing whitespace (often a stray newline or space from pasting); remove it, the value is used exactly as given");
    }
  }

  // 1. Shape and format of every variable that is set. Bad values are dropped before the config is built.
  let parsed: ParsedEnv;
  const first = envSchema.safeParse(env);
  if (first.success) parsed = first.data;
  else {
    const bad = new Set<string>();
    for (const issue of first.error.issues) {
      const variable = String(issue.path[0] ?? "environment");
      bad.add(variable);
      essential(variable, issue.message);
    }
    const rest = { ...env };
    for (const k of bad) delete rest[k];
    parsed = envSchema.parse(rest);
  }

  const host = hostOf(parsed.APP_URL);
  const loopback = host !== undefined && LOOPBACK.has(host);
  const localRun = production && parsed.ALLOW_INSECURE_LOCAL_RUN === true && loopback;
  /** Dev-only settings: refused in production, except under the local-run escape hatch. */
  const devOnly = (variable: string, message: string) =>
    (production && !localRun ? errors : warnings).push(`${variable}: ${message}${localRun ? " [tolerated: ALLOW_INSECURE_LOCAL_RUN=true]" : ""}`);

  if (production && parsed.ALLOW_INSECURE_LOCAL_RUN === true && !loopback) {
    errors.push("ALLOW_INSECURE_LOCAL_RUN: only honoured when APP_URL is http(s)://localhost, 127.0.0.1 or [::1]; remove it from real deployments");
  }

  // 2. Required in every environment (the app throws at first use without them).
  if (!env.DATABASE_URL) essential("DATABASE_URL", "is not set");
  if (!env.APP_SECRET) essential("APP_SECRET", "is not set");
  else if (production && env.APP_SECRET.length < 32) errors.push("APP_SECRET: must be at least 32 characters in production (openssl rand -base64 32)");
  else if (env.APP_SECRET.length < 16) warnings.push("APP_SECRET: must be at least 16 characters or signing fails");
  if (!env.TOKEN_ENCRYPTION_KEY) essential("TOKEN_ENCRYPTION_KEY", "is not set");
  if (
    parsed.TOKEN_ENCRYPTION_KEY_PREVIOUS &&
    parsed.TOKEN_ENCRYPTION_KEY &&
    env.TOKEN_ENCRYPTION_KEY_PREVIOUS === env.TOKEN_ENCRYPTION_KEY
  ) {
    warn("TOKEN_ENCRYPTION_KEY_PREVIOUS", "is identical to TOKEN_ENCRYPTION_KEY; remove it");
  }

  // 3. Production-only requirements.
  if (production) {
    if (!env.APP_URL) errors.push("APP_URL: is not set (it builds every link in emails, webhooks and redirects)");
    else if (parsed.APP_URL && !parsed.APP_URL.startsWith("https://")) devOnly("APP_URL", "must start with https:// in production");
    if (!env.REDIS_URL) errors.push("REDIS_URL: is not set (the job queues and shared rate limits need Redis)");
    for (const v of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
      if (!env[v]) errors.push(`${v}: is not set (payments cannot work without it)`);
    }

    const emailProvider = parsed.EMAIL_PROVIDER ?? "log";
    if (emailProvider === "log") {
      devOnly("EMAIL_PROVIDER", 'must be "resend" or "postmark" in production ("log" only prints emails, customers receive nothing)');
    } else {
      const need = emailProvider === "resend" ? "RESEND_API_KEY" : "POSTMARK_SERVER_TOKEN";
      if (!env[need]) errors.push(`${need}: is not set (EMAIL_PROVIDER=${emailProvider})`);
      if (!env.EMAIL_FROM) errors.push(`EMAIL_FROM: is not set (EMAIL_PROVIDER=${emailProvider})`);
    }
    if (parsed.MESSAGING_DRY_RUN === true) devOnly("MESSAGING_DRY_RUN", "must not be true in production (messages would be logged, never sent)");
    if (parsed.WHATSAPP_DISABLED === true) devOnly("WHATSAPP_DISABLED", "must not be true in production (every WhatsApp message would silently go by SMS instead)");
    if (parsed.READINESS_BYPASS === true) devOnly("READINESS_BYPASS", "must not be true in production (it skips the go-live checks)");
    if (parsed.RATE_LIMIT_ENABLED === false) devOnly("RATE_LIMIT_ENABLED", "must not be false in production (rate limits protect login, holds and checkout)");

    // 4. Advisory warnings.
    if (!env.CLIENT_IP_HEADER) warn("CLIENT_IP_HEADER", "is not set: rate limits fall back to the right-most X-Forwarded-For entry; set the header your platform uses");
    if (!env.ERROR_WEBHOOK_URL) warn("ERROR_WEBHOOK_URL", "is not set: errors only go to the logs, nobody is notified");
    if (parsed.RATE_LIMIT_STORE === "memory") warn("RATE_LIMIT_STORE", 'is "memory": limits are per instance and reset on every restart');
    if (env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")) warn("RAZORPAY_KEY_ID", "is a test-mode key: no real money moves (fine for staging, not for launch)");
    else if (env.RAZORPAY_KEY_ID && !/^rzp_(test|live)_/.test(env.RAZORPAY_KEY_ID)) warn("RAZORPAY_KEY_ID", "does not look like a Razorpay key id (rzp_live_... / rzp_test_...)");
    if (parsed.WHATSAPP_PLATFORM_FALLBACK === true) warn("WHATSAPP_PLATFORM_FALLBACK", "is true: meant for testing with the platform's own number");
    if (parsed.ENABLE_DESIGN_PAGE === true) warn("ENABLE_DESIGN_PAGE", "is true: the /design catalogue is publicly reachable");
    if (parsed.TOKEN_ENCRYPTION_KEY_PREVIOUS) warn("TOKEN_ENCRYPTION_KEY_PREVIOUS", "is set: a key rotation is in progress. Run keys:rotate and keys:verify, then remove it (doc/08-deployment.md)");
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
      warn("GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI", "are not all set: influencers cannot connect Google Calendar, so no Meet links");
    } else if (parsed.APP_URL && hostOf(env.GOOGLE_REDIRECT_URI) !== hostOf(parsed.APP_URL)) {
      warn("GOOGLE_REDIRECT_URI", "is on a different host than APP_URL");
    }
    const sms = parsed.SMS_PROVIDER ?? "generic";
    const smsMissing =
      sms === "msg91"
        ? [!env.SMS_API_KEY && "SMS_API_KEY"]
        : sms === "twilio"
          ? [!env.TWILIO_ACCOUNT_SID && "TWILIO_ACCOUNT_SID", !env.TWILIO_AUTH_TOKEN && "TWILIO_AUTH_TOKEN", !env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM && "TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID"]
          : [!env.SMS_API_KEY && "SMS_API_KEY", !env.SMS_API_URL && "SMS_API_URL"];
    const missing = smsMissing.filter(Boolean);
    if (missing.length) warn("SMS_PROVIDER", `${sms} needs ${missing.join(", ")}: the SMS fallback for WhatsApp will fail`);
    if (!env.WHATSAPP_APP_SECRET || !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      warn("WHATSAPP_APP_SECRET/WHATSAPP_WEBHOOK_VERIFY_TOKEN", "are not both set: Meta's webhook handshake and delivery/template status callbacks will be rejected");
    }
  }

  // 5. Typed, cached view of what was understood. Defaults mirror the code that reads each variable.
  const appUrl = (parsed.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const config = withSecrets(
    {
      nodeEnv: env.NODE_ENV ?? "development",
      isProduction: production,
      appUrl,
      database: {
        poolMax: parsed.DATABASE_POOL_MAX ?? 10,
        statementTimeoutMs: parsed.DATABASE_STATEMENT_TIMEOUT_MS ?? 15_000,
        connectTimeoutMs: parsed.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000,
        idleTimeoutMs: parsed.DATABASE_IDLE_TIMEOUT_MS ?? 30_000,
      },
      redisConfigured: Boolean(parsed.REDIS_URL),
      encryption: {
        fingerprint: keyFingerprintOf(parsed.TOKEN_ENCRYPTION_KEY),
        previousFingerprint: keyFingerprintOf(parsed.TOKEN_ENCRYPTION_KEY_PREVIOUS),
      },
      rateLimit: {
        enabled: parsed.RATE_LIMIT_ENABLED !== false,
        store: parsed.RATE_LIMIT_STORE ?? "auto",
        multiplier: parsed.RATE_LIMIT_MULTIPLIER ?? 1,
      },
      email: { provider: parsed.EMAIL_PROVIDER ?? "log" },
      sms: { provider: parsed.SMS_PROVIDER ?? "generic" },
      messagingDryRun: parsed.MESSAGING_DRY_RUN === true,
      readinessBypass: parsed.READINESS_BYPASS === true && !production,
      razorpay: { keyId: env.RAZORPAY_KEY_ID, testMode: env.RAZORPAY_KEY_ID?.startsWith("rzp_test_") ?? false },
      clientIpHeader: env.CLIENT_IP_HEADER?.toLowerCase(),
    },
    {
      databaseUrl: parsed.DATABASE_URL,
      redisUrl: parsed.REDIS_URL,
      appSecret: env.APP_SECRET,
      tokenEncryptionKey: parseKeyBytes(parsed.TOKEN_ENCRYPTION_KEY) ?? undefined,
      tokenEncryptionKeyPrevious: parseKeyBytes(parsed.TOKEN_ENCRYPTION_KEY_PREVIOUS) ?? undefined,
      razorpayKeySecret: env.RAZORPAY_KEY_SECRET,
      razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    },
  );

  return { production, localRun, errors, warnings, config };
}

/* ---------- process wiring ---------- */

let cached: { config: AppConfig; warnings: string[] } | undefined;
let cachedError: EnvValidationError | undefined;
let logged = false;

/**
 * Validates `process.env` once and returns the typed config. Throws EnvValidationError (every problem in one
 * message) in production; in development it returns the best-effort config and the problems are only warnings.
 */
export function getConfig(): AppConfig {
  if (cachedError) throw cachedError;
  if (cached) return cached.config;
  const report = validateEnv(process.env);
  if (report.errors.length) {
    cachedError = new EnvValidationError(report.errors);
    throw cachedError;
  }
  cached = { config: report.config, warnings: report.warnings };
  return cached.config;
}

/** Test hook: forget the cached result so the next call validates process.env again. */
export function resetConfigForTests(): void {
  cached = undefined;
  cachedError = undefined;
  logged = false;
}

/** Validates, logs the warnings once, and throws EnvValidationError in production. For the web app's start-up hook. */
export function initEnv(label: string): AppConfig {
  const config = getConfig();
  if (!logged) {
    logged = true;
    const warnings = cached?.warnings ?? [];
    for (const w of warnings) console.warn(`[env] warning (${label}): ${w}`);
    if (config.isProduction) console.log(`[env] ${label}: configuration valid for production (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`);
    // Fingerprint only, never the key. Compare it across web and worker instances, and with `keys:rotate`/`keys:verify`
    // output, to be sure every process and every maintenance command is looking at the same key.
    const { fingerprint, previousFingerprint } = config.encryption;
    if (fingerprint) {
      console.log(`[env] ${label}: encryption key fingerprint ${fingerprint}${previousFingerprint ? ` (previous key fingerprint ${previousFingerprint})` : ""}`);
    }
  }
  return config;
}

/** For the worker: validates and, if production configuration is invalid, prints the message and exits with code 1. */
export function initEnvOrExit(label: string): AppConfig {
  try {
    return initEnv(label);
  } catch (e) {
    console.error(`[env] ${label} will not start.\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
