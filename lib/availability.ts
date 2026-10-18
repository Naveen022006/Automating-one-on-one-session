import { istDate } from "@/lib/india";
import { prisma } from "@/lib/db";
import { activeSeatWhere } from "@/lib/holds";
import { publicInfluencerWhere } from "@/lib/public";
import { windowBounds } from "@/lib/booking-window";
import { blockedDaySet, generateSlots, type Rule } from "@/lib/slots";

export interface OpenSlot {
  start: string;
  end: string;
  seatsLeft: number;
}

export interface BookableService {
  id: string;
  influencerId: string;
  durationMin: number;
  capacity: number;
  rules: Rule[];
  minNoticeHours: number;
  maxAdvanceDays: number;
}

/**
 * An active service on a live (public) booking page, with what slot generation needs. The owner (when logged in)
 * can also load their own services before the page is live, for the preview and for rescheduling, and also a service they
 * have hidden since: the bookings that already exist on it stay valid and can still be moved (the reschedule check does not
 * need the service to be active), so the dashboard's time picker has to be able to read its slots. A NEW booking still needs an
 * active service on a live page (the hold route checks that itself), so nobody else can see or use a hidden service's times.
 */
export async function loadBookableService(serviceId: string, viewerInfluencerId?: string | null): Promise<BookableService | null> {
  const service = await prisma.service.findFirst({
    where: {
      id: serviceId,
      OR: [{ active: true, influencer: publicInfluencerWhere }, ...(viewerInfluencerId ? [{ influencerId: viewerInfluencerId }] : [])],
    },
    include: { influencer: { include: { rules: true } } },
  });
  if (!service) return null;
  return {
    id: service.id,
    influencerId: service.influencerId,
    durationMin: service.durationMin,
    capacity: service.capacity,
    rules: service.influencer.rules,
    minNoticeHours: service.minNoticeHours,
    maxAdvanceDays: service.maxAdvanceDays,
  };
}

/** Free slots (with seats left) whose start is in [from, to), never in the past. */
export async function openSlots(
  service: BookableService,
  from: Date,
  to: Date,
  now = new Date(),
  opts: { ignoreWindow?: boolean } = {},
): Promise<OpenSlot[]> {
  // Customers only see slots inside the service's booking window; the owner previewing their own page sees all.
  if (!opts.ignoreWindow) {
    const w = windowBounds(service, now);
    from = new Date(Math.max(from.getTime(), w.earliest.getTime()));
    to = new Date(Math.min(to.getTime(), w.latest.getTime() + 1));
    if (to <= from) return [];
  }
  const blocked = await prisma.blockedDate.findMany({
    where: {
      influencerId: service.influencerId,
      date: { gte: new Date(from.getTime() - 86_400_000), lte: new Date(to.getTime() + 86_400_000) },
    },
    select: { date: true },
  });
  const candidates = generateSlots(
    service.rules,
    service.durationMin,
    new Date(Math.max(from.getTime(), now.getTime())),
    to,
    blockedDaySet(blocked.map((b) => b.date)),
  );
  if (candidates.length === 0) return [];
  const sessions = await prisma.session.findMany({
    where: { serviceId: service.id, startTime: { gte: from, lt: to } },
    include: { bookings: { where: activeSeatWhere(now), select: { id: true } } },
  });
  const taken = new Map<number, number>(sessions.map((s) => [s.startTime.getTime(), s.bookings.length]));
  // The influencer is in one session at a time: their other occupied sessions (any service) block overlapping slots.
  // The same rule is enforced under a lock by createHold (lib/holds.ts); this only keeps such times off the calendar.
  const durationMs = service.durationMin * 60_000;
  const busy = await prisma.session.findMany({
    where: {
      service: { influencerId: service.influencerId },
      startTime: { lt: new Date(candidates[candidates.length - 1].getTime() + durationMs) },
      endTime: { gt: candidates[0] },
      bookings: { some: activeSeatWhere(now) },
    },
    select: { serviceId: true, startTime: true, endTime: true },
  });
  const blockedByOther = (start: Date) => {
    const end = start.getTime() + durationMs;
    return busy.some(
      (b) =>
        !(b.serviceId === service.id && b.startTime.getTime() === start.getTime()) &&
        b.startTime.getTime() < end &&
        b.endTime.getTime() > start.getTime(),
    );
  };
  return candidates
    .filter((start) => !blockedByOther(start))
    .map((start) => ({
      start: start.toISOString(),
      end: new Date(start.getTime() + durationMs).toISOString(),
      seatsLeft: service.capacity - (taken.get(start.getTime()) ?? 0),
    }))
    .filter((s) => s.seatsLeft > 0);
}

/** Pure: the "YYYY-MM-DD" Indian Standard Time days that have at least one open slot. */
export function daysWithSlots(slots: Pick<OpenSlot, "start">[]): string[] {
  const days = new Set<string>();
  for (const s of slots) {
    const t = new Date(s.start);
    if (!Number.isNaN(t.getTime())) days.add(istDate(t));
  }
  return [...days].sort();
}
