import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignShowcase } from "./DesignShowcase";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

// Dev-only component catalogue (doc/07 C2). Hidden in production unless ENABLE_DESIGN_PAGE=true.
export default function DesignPage() {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DESIGN_PAGE !== "true") notFound();
  return <DesignShowcase />;
}
