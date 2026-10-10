import type { Metadata } from "next";
import { ForgotPasswordView } from "@/components/views/auth/ForgotPasswordView";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };

export default function ForgotPasswordPage() {
  return <ForgotPasswordView />;
}
