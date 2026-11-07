/** Only explicit parties on one compatible trip can share a display block. */
export type TravelGroupBooking = {
  id: number;
  direction: string;
  bookingType?: string;
  travelGroupId?: string | null;
  travelGroupOrder?: number | null;
  date?: string;
  time?: string;
  assignedDate?: string | null;
  assignedTime?: string | null;
  requestedDate?: string;
  requestedTime?: string;
  status?: string;
  deletedAt?: string | null;
};

export type TravelBookingGroup<T extends TravelGroupBooking> = {
  key: string;
  bookings: T[];
  grouped: boolean;
};

function compatibleKey(booking: TravelGroupBooking): string | null {
  if (!booking.travelGroupId?.trim() || booking.deletedAt != null
    || (booking.status !== undefined && booking.status !== 'confirmed')
    || booking.bookingType === 'whole_car') return null;
  const date = booking.date ?? booking.assignedDate ?? booking.requestedDate;
  const time = booking.time ?? booking.assignedTime ?? booking.requestedTime;
  if (!date || !time) return null;
  // No phone or caller identity can establish that two independent orders travel together.
  return JSON.stringify([booking.travelGroupId, date, time, booking.direction]);
}

/**
 * Use only the rows actually visible to the viewer. Grouping never requests hidden
 * siblings, invents party membership, or changes the input records/seat accounting.
 * The first visible member keeps the group's position in the caller's chosen order.
 */
export function groupTravelBookings<T extends TravelGroupBooking>(bookings: readonly T[]): TravelBookingGroup<T>[] {
  const candidates = new Map<string, { booking: T; index: number }[]>();
  const keys = bookings.map((booking, index) => {
    const key = compatibleKey(booking);
    if (key) {
      const members = candidates.get(key) ?? [];
      members.push({ booking, index });
      candidates.set(key, members);
    }
    return key;
  });
  const emitted = new Set<string>();
  const result: TravelBookingGroup<T>[] = [];
  bookings.forEach((booking, index) => {
    const key = keys[index];
    const members = key ? candidates.get(key) : undefined;
    if (!key || !members || members.length < 2) {
      result.push({ key: `booking:${booking.id}`, bookings: [booking], grouped: false });
      return;
    }
    if (emitted.has(key)) return;
    emitted.add(key);
    const position = (value: T) => Number.isInteger(value.travelGroupOrder) && value.travelGroupOrder! >= 0
      ? value.travelGroupOrder! : Number.POSITIVE_INFINITY;
    result.push({ key: `party:${key}`, bookings: [...members]
      .sort((first, second) => position(first.booking) - position(second.booking) || first.index - second.index)
      .map(member => member.booking), grouped: true });
  });
  return result;
}
