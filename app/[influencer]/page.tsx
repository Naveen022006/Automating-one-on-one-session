import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconClock, IconUsers, IconVideo } from "@/components/icons";
import { SiteFooter, Wordmark } from "@/components/site/SiteChrome";
import { Alert, Avatar, Badge, ButtonLink, Card, EmptyState } from "@/components/ui/primitives";
import { formatDuration, formatMoney } from "@/lib/format";
import { loadPublicProfile } from "@/lib/public-profile";

export async function generateMetadata({ params }: { params: Promise<{ influencer: string }> }): Promise<Metadata> {
  const { influencer } = await params;
  const profile = await loadPublicProfile(influencer).catch(() => null);
  if (!profile) return { title: "Not found", robots: { index: false } };
  return {
    title: `Book a session with ${profile.name}`,
    description: profile.bio?.slice(0, 160) ?? `Book a paid 1:1 or group session with ${profile.name}.`,
    alternates: { canonical: `/${profile.slug}` },
    robots: profile.preview ? { index: false } : undefined,
  };
}

export default async function ProfilePage({ params }: { params: Promise<{ influencer: string }> }) {
  const { influencer } = await params;
  const profile = await loadPublicProfile(influencer);
  if (!profile) notFound();

  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
        </div>
      </header>
      <main id="main" className="container container--narrow">
        {profile.preview && (
          <div style={{ marginTop: 24 }}>
            <Alert tone="info" title="Preview">
              Only you can see this page until you finish onboarding and confirm your email.
            </Alert>
          </div>
        )}
        <section className="profile-head">
          <Avatar name={profile.name} src={profile.photoUrl} size="lg" />
          <div className="stack stack--sm">
            <h1 className="display" style={{ fontSize: "var(--text-3xl)" }}>
              {profile.name}
            </h1>
            {profile.bio && <p className="muted" style={{ maxWidth: "60ch", whiteSpace: "pre-line" }}>{profile.bio}</p>}
          </div>
        </section>

        <h2 className="section-title" style={{ marginBottom: 16 }}>
          Sessions
        </h2>
        {profile.services.length === 0 ? (
          <EmptyState title="No sessions to book right now">Check back soon.</EmptyState>
        ) : (
          <div className="stack">
            {profile.services.map((s) => (
              <Card key={s.id} className="card--interactive">
                <div className="row row--between" style={{ alignItems: "flex-start" }}>
                  <div className="stack stack--sm" style={{ flex: "1 1 320px" }}>
                    <h3 style={{ fontSize: "var(--text-md)" }}>{s.title}</h3>
                    {s.description && <p className="muted text-sm">{s.description}</p>}
                    <div className="row text-sm muted">
                      <span className="row" style={{ gap: 6 }}>
                        <IconClock size={16} /> {formatDuration(s.durationMin)}
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        {s.type === "GROUP" ? <IconUsers size={16} /> : <IconVideo size={16} />}
                        {s.type === "GROUP" ? `Group, up to ${s.capacity}` : "1:1 on Google Meet"}
                      </span>
                    </div>
                    <p className="subtle">{s.refundText}</p>
                  </div>
                  <div className="stack stack--sm" style={{ alignItems: "flex-end" }}>
                    <Badge tone="accent" plain>
                      <span className="money">{formatMoney(s.priceMinor, s.currency)}</span>
                    </Badge>
                    <ButtonLink href={`/${profile.slug}/book?service=${encodeURIComponent(s.id)}`} variant="primary">
                      Book
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
        <p className="subtle" style={{ marginTop: 32 }}>
          Payments by Razorpay. Your Google Meet link arrives on WhatsApp and email. <Link href="/refund-policy">Refund policy</Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
