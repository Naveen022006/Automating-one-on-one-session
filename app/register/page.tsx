import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { RegisterView } from "@/components/views/auth/RegisterView";
import { getAuth } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create a booking page for your paid 1:1 and group sessions.",
};

export default async function RegisterPage() {
  if (await getAuth()) redirect("/dashboard");
  return <RegisterView />;
}
