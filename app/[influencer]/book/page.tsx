import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookView } from "@/components/views/booking/BookView";
import { jsonify } from "@/lib/jsonify";
import { loadPublicProfile } from "@/lib/public-profile";

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
  return <BookView data={jsonify(profile)} initialServiceId={service ?? null} />;
}
