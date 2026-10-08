import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { getAuth } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Log in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { next, reset } = await searchParams;
  if (await getAuth()) redirect(safeNextPath(next));
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Welcome back</h1>
          <p className="muted">Log in to manage your sessions and booking page.</p>
        </div>
        <LoginForm next={next} notice={reset ? "Your password was changed. Please log in." : undefined} />
        <p className="muted text-sm">
          New here? <Link href="/register">Create an account</Link>
        </p>
      </div>
    </FocusedLayout>
  );
}
