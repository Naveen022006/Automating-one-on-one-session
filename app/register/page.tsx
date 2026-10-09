import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/auth/AuthForms";
import { FocusedLayout } from "@/components/site/SiteChrome";
import { getAuth } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create a booking page for your paid 1:1 and group sessions.",
};

export default async function RegisterPage() {
  if (await getAuth()) redirect("/dashboard");
  return (
    <FocusedLayout>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <h1 className="focused__title">Create your booking page</h1>
          <p className="muted">It takes a few minutes. Your customers will never need an account.</p>
        </div>
        <RegisterForm />
        <p className="muted text-sm">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </div>
    </FocusedLayout>
  );
}
