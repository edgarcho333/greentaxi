export type Direction = 'gori-tbilisi' | 'tbilisi-gori';
export const directions: Record<Direction, string> = {
  'gori-tbilisi': 'გორი → თბილისი',
  'tbilisi-gori': 'თბილისი → გორი',
};
export type User = { id: number; login: string; name: string };
export type Stop = { id: number; name: string; address: string; active: boolean };
export type PublicConfig = { stops: Stop[]; didubeName: string; didubeAddress: string };
export type Slot = { time: string; active: boolean; bookingCount: number; seatCount: number };
export type Booking = {
  id: number; name: string; phone: string; seats: number; direction: Direction;
  goriAddress: string; pickupStopId: number | null; pickupStopName: string | null;
  didubeName: string; didubeAddress: string;
  requestedDate: string; requestedTime: string; assignedDate: string | null;
  assignedTime: string | null; status: 'waiting' | 'confirmed';
  deletedAt: string | null; createdAt: string; updatedAt: string;
};
export type Schedule = { direction: Direction; date: string; baseTimes: string[]; overrideTimes: string[] | null; slots: Slot[] };
export type Passenger = {
  name: string; phone: string; address: string; addressCity: 'gori' | 'tbilisi' | null;
  orderCount: number; seats: number; latestDate: string;
};
export type PassengerProfile = {
  phone: string; name: string; goriAddress: string; goriPickupAddress: string;
  pickupStopId: number | null; pickupStopName: string | null; updatedAt: string;
};
export type PassengerDetail = { passenger: Passenger; profile: PassengerProfile | null; bookings: Booking[] };
export type Analytics = {
  totals: { incoming: number; confirmed: number; deleted: number; seats: number };
  directions: { direction: Direction; orders: number; seats: number }[];
  days: { date: string; orders: number; seats: number }[];
};
export type CallDevice = { id: number; name: string; active: boolean; createdAt: string; lastSeenAt: string | null };
export type CallInquiry = {
  id: number; phone: string | null; occurredAt: string; durationSeconds: number;
  deviceName: string; createdAt: string; deletedAt: string | null; bookingId: number | null;
  phase: 'answered' | 'completed'; passengerProfile: PassengerProfile | null;
};
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.', response.status, data.code);
  return data as T;
}
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function addDays(date: string, count: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + count);
  return parsed.toISOString().slice(0, 10);
}
