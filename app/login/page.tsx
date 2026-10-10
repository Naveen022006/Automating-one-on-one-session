import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginView } from "@/components/views/auth/LoginView";
import { getAuth } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Log in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { next, reset } = await searchParams;
  if (await getAuth()) redirect(safeNextPath(next));
  return <LoginView next={next} reset={reset} />;
}
