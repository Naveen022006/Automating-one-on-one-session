import type { Metadata } from "next";
import { headers } from "next/headers";
import { LandingView } from "@/components/views/public/LandingView";
import { getAuth } from "@/lib/auth/session";
import { BRAND_NAME, SUPPORT_EMAIL, appUrl } from "@/lib/brand";

export const metadata: Metadata = {
  title: { absolute: `${BRAND_NAME}: get paid for your time, send the Meet link automatically` },
  alternates: { canonical: "/" },
};

export default async function LandingPage() {
  const [auth, h] = await Promise.all([getAuth().catch(() => null), headers()]);
  const nonce = h.get("x-nonce") ?? undefined;
  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: BRAND_NAME,
    url: appUrl(),
    email: SUPPORT_EMAIL,
  };

  return (
    <>
      <LandingView loggedIn={Boolean(auth)} />
      <script
        type="application/ld+json"
        nonce={nonce}
        // JSON.stringify output with "<" escaped cannot break out of the script element.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd).replace(/</g, "\\u003c") }}
      />
    </>
  );
}
