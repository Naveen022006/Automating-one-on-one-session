import type { GoogleStatusView } from "@/components/app/GoogleConnect";
import type { ProfileData } from "@/components/app/SettingsForms";
import type { WhatsAppView } from "@/components/app/WhatsAppConnect";
import type { AuthContext } from "@/lib/auth/session";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { getGoogleStatus, type GoogleConnectionStatus } from "@/lib/google-tokens";
import { getConnectionView, type WhatsAppConnectionView } from "@/lib/whatsapp-connection";
import { embeddedSignupConfig } from "@/lib/whatsapp-connect";

/**
 * The Settings page, and the pieces the onboarding wizard shares with it (profile, Google panel, WhatsApp panel).
 * Shared by the old Next page (app/dashboard/settings/page.tsx), GET /api/dashboard/settings and loadOnboardingView.
 *
 * This is the most sensitive influencer screen, so the rule of doc/10 section 2.8 is applied literally: every object is
 * built field by field from what the panels render. The stored rows hold encrypted Google refresh tokens and WhatsApp
 * access tokens; none of those columns is selected by any function in this file, and the connection views below are
 * copied field by field (never spread).
 */
export interface DashboardSettingsView {
  profile: ProfileData;
  google: GoogleStatusView;
  whatsapp: WhatsAppView | null;
  /** The Meta app and Embedded Signup configuration ids the Facebook SDK needs in the browser (public by design), or null when not configured. */
  embedded: EmbeddedSignupView | null;
  /** The site address without the scheme, as the booking-page-address field prints it ("example.com"). */
  origin: string;
  email: string;
  emailVerified: boolean;
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
    select: { name: true, bio: true, photoUrl: true, timezone: true, slug: true, notifyByEmail: true },
  });
  return {
    name: influencer.name,
    bio: influencer.bio,
    photoUrl: influencer.photoUrl,
    timezone: influencer.timezone,
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
  const [profile, google, whatsapp] = await Promise.all([loadProfileView(auth.influencerId), loadGoogleStatusView(auth.influencerId), loadWhatsAppView(auth.influencerId)]);
  return {
    profile,
    google,
    whatsapp,
    embedded: loadEmbeddedSignupView(),
    origin: appUrl().replace(/^https?:\/\//, ""),
    email: auth.email,
    emailVerified: auth.emailVerified,
  };
}
