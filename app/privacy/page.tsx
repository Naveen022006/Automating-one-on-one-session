import type { Metadata } from "next";
import { PrivacyView } from "@/components/views/public/PrivacyView";

export const metadata: Metadata = { title: "Privacy Policy", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  return <PrivacyView />;
}
