import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import { headers } from "next/headers";
import { BRAND_NAME, appUrl } from "@/lib/brand";
import "./globals.css";

// Self-hosted at build time by next/font (no runtime request to Google). One pairing, used everywhere:
// Newsreader for display headings, Inter for interface text.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap" });

const description =
  "Sell 1:1 and small-group sessions. Customers pick a time and pay; the Google Meet link is created and sent on WhatsApp and email automatically, with reminders.";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: { default: `${BRAND_NAME}: paid sessions with automatic Meet links`, template: `%s · ${BRAND_NAME}` },
  description,
  applicationName: BRAND_NAME,
  openGraph: { type: "website", siteName: BRAND_NAME, title: BRAND_NAME, description },
  twitter: { card: "summary_large_image", title: BRAND_NAME, description },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#fbfaf7",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request headers keeps every page dynamically rendered, so Next.js can stamp the per-request CSP
  // nonce from proxy.ts onto its scripts (a statically prerendered page could not carry a nonce).
  await headers();
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable}`}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
