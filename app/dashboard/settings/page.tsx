import type { Metadata } from "next";
import { PageHead } from "@/components/app/AppShell";
import { GoogleConnect, type GoogleStatusView } from "@/components/app/GoogleConnect";
import { WhatsAppConnect } from "@/components/app/WhatsAppConnect";
import { DeviceSessions, NotificationPrefs, PasswordForm, ProfileForm, SlugForm, VerifyBanner } from "@/components/app/SettingsForms";
import { Card } from "@/components/ui/primitives";
import { requirePageAuth } from "@/lib/auth/guards";
import { appUrl } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { getGoogleStatus } from "@/lib/google-tokens";
import { getConnectionView } from "@/lib/whatsapp-connection";
import { embeddedSignupConfig } from "@/lib/whatsapp-connect";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ google?: string }> }) {
  const auth = await requirePageAuth("/dashboard/settings");
  const { google: outcome } = await searchParams;
  const [influencer, google, whatsapp] = await Promise.all([
    prisma.influencer.findUniqueOrThrow({
      where: { id: auth.influencerId },
      select: { name: true, bio: true, photoUrl: true, timezone: true, slug: true, notifyByEmail: true },
    }),
    getGoogleStatus(auth.influencerId, { details: true }),
    getConnectionView(auth.influencerId),
  ]);
  const googleView: GoogleStatusView =
    google.state === "connected"
      ? { state: "connected", email: google.email, connectedAt: google.connectedAt.toISOString(), gmailSend: google.gmailSend, liveEvents: google.liveEvents ?? 0, gmailFailing: google.gmailFailing ?? false }
      : google.state === "reconnect-needed"
        ? { state: "reconnect-needed", email: google.email, reason: google.reason, liveEvents: google.liveEvents ?? 0 }
        : { state: "not-connected", requestsGmail: google.requestsGmail };

  return (
    <div className="stack stack--lg">
      <PageHead title="Settings" description="Your profile, booking page, Google Calendar connection and account security." />
      {!auth.emailVerified && <VerifyBanner email={auth.email} />}
      <Card title="Profile">
        <ProfileForm profile={influencer} />
      </Card>
      <Card title="Booking page">
        <SlugForm slug={influencer.slug} origin={appUrl().replace(/^https?:\/\//, "")} />
      </Card>
      <Card title={<h2 className="card__title" id="google">Google Calendar</h2>}>
        <GoogleConnect status={googleView} returnTo="/dashboard/settings" outcome={outcome ?? null} />
      </Card>
      <Card title={<h2 className="card__title" id="whatsapp">WhatsApp</h2>}>
        <WhatsAppConnect
          connection={whatsapp ? { displayPhone: whatsapp.displayPhone, verifiedName: whatsapp.verifiedName, source: whatsapp.source, status: whatsapp.status, lastError: whatsapp.lastError, templates: whatsapp.templates, ready: whatsapp.ready } : null}
          embedded={embeddedSignupConfig()}
        />
      </Card>
      <Card title="Notifications">
        <NotificationPrefs notifyByEmail={influencer.notifyByEmail} />
      </Card>
      <Card title="Password">
        <PasswordForm />
      </Card>
      <Card title="Signed-in devices">
        <DeviceSessions />
      </Card>
    </div>
  );
}
