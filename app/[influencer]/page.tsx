import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileView } from "@/components/views/booking/ProfileView";
import { jsonify } from "@/lib/jsonify";
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
  return <ProfileView data={jsonify(profile)} />;
}
