import { normalizePhone } from './phone.js';

export type CallBookingIdentity = { phone: string; callerPhone?: string | null };

/** A caller is an association on a booking, never a passenger identity merge. */
export function bookingMatchesCall(booking: CallBookingIdentity, callerPhone: string | null, contactPhone: string | null): boolean {
  const caller = callerPhone === null ? null : normalizePhone(callerPhone);
  const contact = contactPhone === null ? null : normalizePhone(contactPhone);
  const bookingContact = normalizePhone(booking.phone);
  const bookingCaller = typeof booking.callerPhone === 'string' ? normalizePhone(booking.callerPhone) : null;
  return Boolean((caller && (bookingContact === caller || bookingCaller === caller)) || (contact && bookingContact === contact));
}

/** All undeleted orders on this civil day or later stay visible, including earlier hours today. */
export function isActiveCallBooking(booking: { deletedAt: string | null; assignedDate: string | null; requestedDate: string }, today: string): boolean {
  return booking.deletedAt === null && (booking.assignedDate ?? booking.requestedDate) >= today;
}
