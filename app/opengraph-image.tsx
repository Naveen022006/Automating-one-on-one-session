import { ImageResponse } from "next/og";
import { BRAND_NAME } from "@/lib/brand";

export const alt = `${BRAND_NAME}: paid sessions with automatic Google Meet links`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Open Graph card in the product's visual language: ink on warm paper, one green accent.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#fbfaf7",
          color: "#162033",
          fontFamily: "Georgia, serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 32 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "#162033" }} />
          {BRAND_NAME}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 72, lineHeight: 1.08, letterSpacing: -1.5, maxWidth: 980 }}>
            Get paid for your time. The Meet link sends itself.
          </div>
          <div style={{ fontSize: 30, color: "#5b5850", fontFamily: "sans-serif" }}>
            Booking, Razorpay payments, Google Meet links, WhatsApp and email reminders.
          </div>
        </div>
        <div style={{ display: "flex", height: 8, width: 160, background: "#17694f", borderRadius: 4 }} />
      </div>
    ),
    size,
  );
}
