import type { MockState, MockTemplate } from "./state";

/**
 * Every FAKE value of the mock providers lives here: credentials, accounts, WABAs and phone numbers. Nothing is real. Every
 * secret-like value starts with MOCK-NOT-REAL- (so it can never be mistaken for a real one, trips no secret scanner, and is
 * refused by the production start-up check in lib/env.ts), Google accounts end in @mock-google.invalid (.invalid is a reserved
 * TLD that can never resolve), and ids are digits because the app requires them to be (lib/whatsapp-connection.ts).
 *
 * This module is also the ONE place the environment overlay of `npm run dev:mock` is defined (mockEnvOverlay). It is handed to
 * the processes the launcher starts and never written to a file.
 */

export const MOCK_PREFIX = "MOCK-NOT-REAL-";

export const GOOGLE_CLIENT_ID = "mock-client-id.apps.mock-google.invalid";
export const GOOGLE_CLIENT_SECRET = "MOCK-NOT-REAL-google-client-secret";
export const MOCK_ACCOUNT_DOMAIN = "mock-google.invalid";
export const GOOGLE_ACCOUNTS = [
  { email: "creator@mock-google.invalid", name: "Mock Creator", sub: "mock-sub-0001" },
  { email: "second-account@mock-google.invalid", name: "Mock Second Account", sub: "mock-sub-0002" },
] as const;

export const META_APP_ID = "990000000000001";
export const META_APP_SECRET = "MOCK-NOT-REAL-meta-app-secret";
export const META_ES_CONFIG_ID = "990000000000002";
/** The "influencer's own Meta app": a token issued for it is the wrong app for our webhooks (the app must say so). */
export const OWN_APP_ID = "990000000000009";
export const PLATFORM_APP_NAME = "Mock Platform App";
export const OWN_APP_NAME = "Mock Influencer Own App";

export const WEBHOOK_VERIFY_TOKEN = "MOCK-NOT-REAL-verify-token";
export const SMS_API_KEY = "MOCK-NOT-REAL-sms-key";

export const WABA_NEW = "990000000001001";
export const WABA_OLD_TEMPLATE = "990000000001002";
export const WABA_BIG = "990000000001003";
export const PHONE_FRESH = "990000000002001";
export const PHONE_UNKNOWN_PIN = "990000000002002";
export const PHONE_MANUAL = "990000000002003";
export const PHONE_BIG = "990000000002004";

export const SCOPE_MANAGEMENT = "whatsapp_business_management";
export const SCOPE_MESSAGING = "whatsapp_business_messaging";

export function mockEnvOverlay(mockUrl: string, appUrl: string): Record<string, string> {
  return {
    MOCK_PROVIDERS_URL: mockUrl,
    APP_URL: appUrl,
    // Influencers bring their own Google client (doc/15): the mock accepts any pair they paste, so the whole flow can be walked through.
    // The shared pair below is only for code that names no influencer (and for mode "platform" or "either" if you set it by hand).
    GOOGLE_CLIENT_MODE: "own",
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: `${appUrl}/api/google/callback`,
    GOOGLE_REQUEST_GMAIL_SEND: "true",
    META_APP_ID,
    META_APP_SECRET,
    WHATSAPP_APP_SECRET: META_APP_SECRET,
    META_ES_CONFIG_ID,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_TEMPLATE_LANGUAGE: "en",
    WHATSAPP_DISABLED: "false",
    WHATSAPP_PLATFORM_FALLBACK: "false",
    MESSAGING_DRY_RUN: "false",
    SMS_PROVIDER: "generic",
    SMS_API_URL: `${mockUrl}/sms/send`,
    SMS_API_KEY,
  };
}

function template(id: string, name: string, body: string, status: MockTemplate["status"], now: number): MockTemplate {
  return { id, name, language: "en", category: "UTILITY", status, rejectedReason: null, body, examples: [], createdAt: new Date(now).toISOString(), decideAt: null };
}

/** The fake Meta side at start: three WhatsApp Business Accounts with four numbers, in the states the walk-through needs. */
export function seedMeta(now: number): MockState["meta"] {
  const big: Record<string, MockTemplate> = {};
  for (let i = 1; i <= 150; i++) {
    const n = String(i).padStart(3, "0");
    const id = `99000000003${n}`;
    big[id] = template(id, `mock_filler_${n}`, `Mock filler template number ${i}, there only to make the list long enough to need several pages.`, "APPROVED", now);
  }
  const old = template("990000000003900", "sa_reschedule", "Hello {{1}}, your appointment was moved to {{2}}. Reply to this message if that does not suit you.", "APPROVED", now);
  return {
    wabas: {
      [WABA_NEW]: { id: WABA_NEW, name: "Mock Coaching (new account)", phoneIds: [PHONE_FRESH, PHONE_UNKNOWN_PIN], subscribedApps: [], templates: {} },
      [WABA_OLD_TEMPLATE]: { id: WABA_OLD_TEMPLATE, name: "Mock Studio (has an old template)", phoneIds: [PHONE_MANUAL], subscribedApps: [], templates: { [old.id]: old } },
      [WABA_BIG]: { id: WABA_BIG, name: "Mock Big Account", phoneIds: [PHONE_BIG], subscribedApps: [], templates: big },
    },
    phones: {
      [PHONE_FRESH]: { id: PHONE_FRESH, wabaId: WABA_NEW, display: "+91 00000 02001", verifiedName: "Mock Coaching", quality: "GREEN", registered: false, pin: null, wrongAttempts: 0, lockedUntil: null },
      [PHONE_UNKNOWN_PIN]: { id: PHONE_UNKNOWN_PIN, wabaId: WABA_NEW, display: "+91 00000 02002", verifiedName: "Mock Coaching", quality: "GREEN", registered: true, pin: "123456", wrongAttempts: 0, lockedUntil: null },
      [PHONE_MANUAL]: { id: PHONE_MANUAL, wabaId: WABA_OLD_TEMPLATE, display: "+91 00000 02003", verifiedName: "Mock Studio", quality: "GREEN", registered: true, pin: null, wrongAttempts: 0, lockedUntil: null },
      [PHONE_BIG]: { id: PHONE_BIG, wabaId: WABA_BIG, display: "+91 00000 02004", verifiedName: "Mock Big Account", quality: "GREEN", registered: true, pin: null, wrongAttempts: 0, lockedUntil: null },
    },
    tokens: {},
    esCodes: {},
    messages: {},
  };
}
