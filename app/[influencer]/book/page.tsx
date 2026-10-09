import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/site/SiteChrome";
import { Alert } from "@/components/ui/primitives";
import { loadPublicProfile } from "@/lib/public-profile";
import { BookingFlow } from "./BookingFlow";

export async function generateMetadata({ params }: { params: Promise<{ influencer: string }> }): Promise<Metadata> {
  const { influencer } = await params;
  const profile = await loadPublicProfile(influencer).catch(() => null);
  return profile
    ? { title: `Book ${profile.name}`, alternates: { canonical: `/${profile.slug}/book` }, robots: profile.preview ? { index: false } : undefined }
    : { title: "Not found", robots: { index: false } };
}

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ influencer: string }>;
  searchParams: Promise<{ service?: string }>;
}) {
  const [{ influencer }, { service }] = await Promise.all([params, searchParams]);
  const profile = await loadPublicProfile(influencer);
  if (!profile) notFound();

  return (
    <div className="focused">
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
          <div className="site-header__actions">
            <Link href={`/${profile.slug}`} className="text-sm">
              {profile.name}&rsquo;s page
            </Link>
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
          host={{ name: profile.name, photoUrl: profile.photoUrl, slug: profile.slug, timezone: profile.timezone }}
          services={profile.services}
          initialServiceId={service ?? null}
          preview={profile.preview}
        />
      </main>
    </div>
  );
}
