import type { Metadata } from "next";
import { ContactView } from "@/components/views/public/ContactView";

export const metadata: Metadata = { title: "Contact", alternates: { canonical: "/contact" } };

export default function ContactPage() {
  return <ContactView />;
}
