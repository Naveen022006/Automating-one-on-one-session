import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { requirePageAuth } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: { default: "Dashboard", template: "%s · Dashboard" }, robots: { index: false } };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await requirePageAuth("/dashboard");
  const [influencer, attention] = await Promise.all([
    prisma.influencer.findUnique({ where: { id: auth.influencerId }, select: { photoUrl: true, googleToken: { select: { status: true } } } }),
    prisma.payment.count({ where: { needsRefund: true, status: "CAPTURED", booking: { session: { service: { influencerId: auth.influencerId } } } } }),
  ]);
  const googleIssue = !influencer?.googleToken || influencer.googleToken.status !== "ACTIVE" ? 1 : 0;
  return (
    <AppShell
      user={{ name: auth.influencerName, email: auth.email, slug: auth.influencerSlug, photoUrl: influencer?.photoUrl ?? null }}
      attentionCount={attention + googleIssue + (auth.emailVerified ? 0 : 1)}
    >
      {children}
    </AppShell>
  );
}
