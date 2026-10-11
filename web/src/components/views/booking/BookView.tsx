import { AppLink } from "@web/lib/link";
import { Wordmark } from "@web/components/site/SiteChrome";
import { Alert } from "@web/components/ui/primitives";
import { BookingFlow } from "@web/pages/booking/BookingFlow";
import type { Jsonify } from "@/lib/jsonify";
import type { PublicProfile } from "@/lib/public-profile";

/**
 * The booking flow page (`/:slug/book`). `initialServiceId` is the `?service=` search parameter, passed in by the page
 * (the old Next page and the SPA page each read the URL themselves). The flow is keyed by the host, so a client-side
 * move from one host's booking page to another's can never carry half a booking over.
 */
export function BookView({ data: profile, initialServiceId }: { data: Jsonify<PublicProfile>; initialServiceId: string | null }) {
  return (
    <div className="focused">
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
          <div className="site-header__actions">
            <AppLink href={`/${profile.slug}`} className="text-sm">
              {profile.name}&rsquo;s page
            </AppLink>
          </div>
        </div>
      </header>
      <main id="main" className="container" style={{ paddingTop: 32, paddingBottom: 64 }}>
        {profile.preview && (
          <div style={{ marginBottom: 24 }}>
            <Alert tone="info" title="Preview">
              This is how customers will see booking. Holding a slot is disabled until your page is live.
              {profile.blockers.length > 0 && <> Still to do: {profile.blockers.join(", ")}.</>}
            </Alert>
          </div>
        )}
        <BookingFlow
          key={profile.slug}
          host={{ name: profile.name, photoUrl: profile.photoUrl, slug: profile.slug, timezone: profile.timezone }}
          services={profile.services}
          initialServiceId={initialServiceId}
          preview={profile.preview}
        />
      </main>
    </div>
  );
}
