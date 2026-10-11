import { PageHead } from "@web/components/app/AppShell";
import { GoogleConnect } from "@web/components/app/GoogleConnect";
import { WhatsAppConnect } from "@web/components/app/WhatsAppConnect";
import { DeviceSessions, NotificationPrefs, PasswordForm, ProfileForm, SlugForm, VerifyBanner } from "@web/components/app/SettingsForms";
import { Card } from "@web/components/ui/primitives";
import type { Jsonify } from "@/lib/jsonify";
import type { DashboardSettingsView } from "@/lib/views/dashboard-settings";

/**
 * The Settings page body. Rendered by the SPA page from the endpoint's JSON. `outcome` is the
 * `?google=` value Google's return trip put in the URL (a banner above the Google panel).
 */
export function SettingsView({ data, outcome }: { data: Jsonify<DashboardSettingsView>; outcome: string | null }) {
  return (
    <div className="stack stack--lg">
      <PageHead title="Settings" description="Your profile, booking page, Google Calendar connection and account security." />
      {!data.emailVerified && <VerifyBanner email={data.email} />}
      <Card title="Profile">
        <ProfileForm profile={data.profile} />
      </Card>
      <Card title="Booking page">
        <SlugForm slug={data.profile.slug} origin={data.origin} />
      </Card>
      <Card title={<h2 className="card__title" id="google">Google Calendar</h2>}>
        <GoogleConnect status={data.google} returnTo="/dashboard/settings#google" outcome={outcome} />
      </Card>
      <Card title={<h2 className="card__title" id="whatsapp">WhatsApp</h2>}>
        <WhatsAppConnect connection={data.whatsapp} embedded={data.embedded} required={data.whatsappRequired} />
      </Card>
      <Card title="Notifications">
        <NotificationPrefs notifyByEmail={data.profile.notifyByEmail} />
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
