import type { AuthContext } from "@/lib/auth/session";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { platformEmailEnabled } from "@/lib/email/providers";
import { CALENDAR_SCOPE, GMAIL_SEND_SCOPE, IDENTITY_SCOPES } from "@/lib/google";
import { getSavedGoogleClient, googleClientMode, googleRedirectUri, platformGoogleCredentials, toClientKind } from "@/lib/google-credentials";
import { getGoogleStatus, type GoogleConnectionStatus } from "@/lib/google-tokens";
import { requiredConnections } from "@/lib/readiness";
import type { GoogleClientView, GoogleStatusView, ProfileData, WhatsAppView } from "@/lib/views/dashboard-types";
import { getConnectionView, type WhatsAppConnectionView } from "@/lib/whatsapp-connection";
import { embeddedSignupConfig } from "@/lib/whatsapp-connect";

/**
 * The Settings page, and the pieces the onboarding wizard shares with it (profile, Google panel, WhatsApp panel).
 * Shared by GET /api/dashboard/settings and loadOnboardingView.
 *
 * This is the most sensitive influencer screen, so the rule of doc/10 section 2.8 is applied literally: every object is
 * built field by field from what the panels render. The stored rows hold encrypted Google refresh tokens and WhatsApp
 * access tokens; none of those columns is selected by any function in this file, and the connection views below are
 * copied field by field (never spread).
 */
export interface DashboardSettingsView {
  profile: ProfileData;
  google: GoogleStatusView;
  /** The influencer's own Google client (step 1 and 2 of the Google card). Never the secret. */
  googleClient: GoogleClientView;
  whatsapp: WhatsAppView | null;
  /** The Meta app and Embedded Signup configuration ids the Facebook SDK needs in the browser (public by design), or null when not configured. */
  embedded: EmbeddedSignupView | null;
  /** Whether the go-live checklist requires WhatsApp (READINESS_REQUIRED), so its card says "Required" instead of "Recommended". */
  whatsappRequired: boolean;
  /** The site address without the scheme, as the booking-page-address field prints it ("example.com"). */
  origin: string;
  email: string;
  emailVerified: boolean;
  /** Whether the platform sends e-mail at all (false with EMAIL_PROVIDER=none): decides whether the page may say "we e-mailed you". */
  emailEnabled: boolean;
}

export interface EmbeddedSignupView {
  appId: string;
  configId: string;
  graphVersion: string;
  /**
   * The local mock's Facebook SDK (doc/11-provider-simulator.md). Present ONLY while the guarded mock override is active in
   * development, copied from `embeddedSignupConfig()` and never made up here; the browser accepts it only if it is a loopback
   * mock URL (lib/facebook-sdk.ts). Absent everywhere else, which is the normal case.
   */
  sdkUrl?: string;
}

export async function loadProfileView(influencerId: string): Promise<ProfileData> {
  const influencer = await prisma.influencer.findUniqueOrThrow({
    where: { id: influencerId },
    select: { name: true, bio: true, photoUrl: true, slug: true, notifyByEmail: true },
  });
  return {
    name: influencer.name,
    bio: influencer.bio,
    photoUrl: influencer.photoUrl,
    slug: influencer.slug,
    notifyByEmail: influencer.notifyByEmail,
  };
}

/** What the Google panel shows. `connectedAt` is an ISO string already (the panel's own type says so). */
export function toGoogleStatusView(google: GoogleConnectionStatus): GoogleStatusView {
  return google.state === "connected"
    ? { state: "connected", email: google.email, connectedAt: google.connectedAt.toISOString(), gmailSend: google.gmailSend, liveEvents: google.liveEvents ?? 0, gmailFailing: google.gmailFailing ?? false }
    : google.state === "reconnect-needed"
      ? { state: "reconnect-needed", email: google.email, reason: google.reason, liveEvents: google.liveEvents ?? 0 }
      : { state: "not-connected", requestsGmail: google.requestsGmail, liveEvents: google.liveEvents ?? 0, previousEmail: google.previousEmail ?? null };
}

export async function loadGoogleStatusView(influencerId: string): Promise<GoogleStatusView> {
  return toGoogleStatusView(await getGoogleStatus(influencerId, { details: true }));
}

/** The OAuth scopes the influencer's consent screen must list, in the order the guide shows them. */
export const GOOGLE_REQUIRED_SCOPES = [CALENDAR_SCOPE, GMAIL_SEND_SCOPE, ...IDENTITY_SCOPES];

/** What the three-step Google card needs to know about the influencer's own Google client. Never the secret (only "saved"). */
export function toGoogleClientView(input: {
  saved: { clientId: string; checkedAt: Date } | null;
  grantKind: string | null;
  env?: Record<string, string | undefined>;
}): GoogleClientView {
  const env = input.env ?? process.env;
  const mode = googleClientMode(env);
  const hasOwnClient = input.saved !== null;
  const platformAvailable = platformGoogleCredentials(env) !== null;
  return {
    mode,
    hasOwnClient,
    clientId: input.saved?.clientId ?? null,
    clientSecretSaved: hasOwnClient,
    checkedAt: input.saved ? input.saved.checkedAt.toISOString() : null,
    redirectUri: googleRedirectUri(env),
    origin: (env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
    requiredScopes: [...GOOGLE_REQUIRED_SCOPES],
    canConnect: mode === "platform" ? platformAvailable : mode === "either" ? hasOwnClient || platformAvailable : hasOwnClient,
    grantClient: input.grantKind === null ? null : toClientKind(input.grantKind),
  };
}

export async function loadGoogleClientView(influencerId: string): Promise<GoogleClientView> {
  const [saved, token] = await Promise.all([
    getSavedGoogleClient(influencerId),
    prisma.googleToken.findUnique({ where: { influencerId }, select: { clientKind: true } }),
  ]);
  return toGoogleClientView({ saved, grantKind: token ? token.clientKind : null });
}

/** What the WhatsApp panel shows: the number and the template states. Never the ids or the access token behind them. */
export function toWhatsAppView(connection: WhatsAppConnectionView | null): WhatsAppView | null {
  if (!connection) return null;
  return {
    displayPhone: connection.displayPhone,
    verifiedName: connection.verifiedName,
    source: connection.source,
    status: connection.status,
    lastError: connection.lastError,
    templates: connection.templates.map((t) => ({ name: t.name, status: t.status, reason: t.reason })),
    ready: connection.ready,
  };
}

export async function loadWhatsAppView(influencerId: string): Promise<WhatsAppView | null> {
  return toWhatsAppView(await getConnectionView(influencerId));
}

/** `embeddedSignupConfig()` without its prototype and anything a future version might add. */
export function loadEmbeddedSignupView(): EmbeddedSignupView | null {
  const config = embeddedSignupConfig();
  return config ? { appId: config.appId, configId: config.configId, graphVersion: config.graphVersion, ...(config.sdkUrl ? { sdkUrl: config.sdkUrl } : {}) } : null;
}

export async function loadSettingsView(auth: AuthContext): Promise<DashboardSettingsView> {
  const [profile, google, googleClient, whatsapp] = await Promise.all([
    loadProfileView(auth.influencerId),
    loadGoogleStatusView(auth.influencerId),
    loadGoogleClientView(auth.influencerId),
    loadWhatsAppView(auth.influencerId),
  ]);
  return {
    profile,
    google,
    googleClient,
    whatsapp,
    embedded: loadEmbeddedSignupView(),
    whatsappRequired: requiredConnections().includes("whatsapp"),
    origin: appUrl().replace(/^https?:\/\//, ""),
    email: auth.email,
    emailVerified: auth.emailVerified,
    emailEnabled: platformEmailEnabled(),
  };
}
