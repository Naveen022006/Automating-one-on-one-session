import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Polled by the booking page after checkout. Status only: the browser never decides that a payment succeeded.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    select: { status: true, holdExpiresAt: true, meetLink: true },
  });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(booking);
}
