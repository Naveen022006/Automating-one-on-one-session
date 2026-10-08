import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Book a session",
  description: "Book a 1:1 or group session",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
