import type { Metadata } from "next";
import { TermsView } from "@/components/views/public/TermsView";

export const metadata: Metadata = { title: "Terms of Service", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  return <TermsView />;
}
