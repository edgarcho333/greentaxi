import { addDays, today, type Analytics, type Booking, type CallInquiry, type Direction, type Passenger, type PassengerProfile, type PublicConfig, type Schedule, type User } from './api';
import { canonicalPassengerPhone } from './components/admin/usePassengerProfile';

export const previewUser: User = { id: 1, login: 'preview', name: 'სატესტო ოპერატორი' };
export const previewOnlyMessage = 'ამ HTML ფაილში მხოლოდ დიზაინის ნახვაა შესაძლებელი. რეალური მოქმედებებისთვის გაუშვით აპლიკაციის სერვერი.';
const baseTimes = [...Array.from({ length: 16 }, (_, index) => `${String(index + 6).padStart(2, '0')}:00`), '08:30', '09:30'].sort();
const directionList: Direction[] = ['gori-tbilisi', 'tbilisi-gori'];
const config: PublicConfig = {
  stops: [1, 2, 3].map(id => ({ id, name: `სატესტო გაჩერება №${id}`, address: `სატესტო მისამართი თბილისში №${id}`, active: true })),
  didubeName: 'დიდუბე', didubeAddress: 'სატესტო მონაცემი — ზუსტი მისამართი დასაზუსტებელია',
};

function sampleBookings(day: string): Booking[] {
  const names = ['ნიკა', 'ანა', 'ლუკა', 'მარი', 'გიო', 'საბა', 'ნინო', 'თინა'];
  const samples: { direction: Direction; time: string; seats: number; offset?: number; status?: Booking['status']; deleted?: boolean }[] = [
    ...baseTimes.map((time, index) => ({ direction: 'gori-tbilisi' as const, time, seats: index % 4 + 1 })),
    { direction: 'tbilisi-gori', time: '08:00', seats: 2 },
    { direction: 'tbilisi-gori', time: '09:30', seats: 1 },
    { direction: 'tbilisi-gori', time: '19:00', seats: 3 },
    { direction: 'gori-tbilisi', time: '10:00', seats: 2, offset: 1, status: 'waiting' },
    { direction: 'tbilisi-gori', time: '08:30', seats: 1, offset: 1, status: 'waiting' },
    { direction: 'gori-tbilisi', time: '08:30', seats: 4, offset: 1 },
    { direction: 'tbilisi-gori', time: '09:30', seats: 2, offset: 1 },
    { direction: 'gori-tbilisi', time: '11:00', seats: 1, deleted: true },
  ];
  return samples.map((sample, index) => {
    const status = sample.status ?? 'confirmed';
    const date = addDays(day, sample.offset ?? 0);
    const stop = config.stops[index % config.stops.length];
    return {
      id: index + 1, name: `სატესტო ${names[index % names.length]}`, phone: `0000000${String(index + 1).padStart(2, '0')}`,
      seats: sample.seats, direction: sample.direction, goriAddress: `სატესტო ქ. №${index + 1}`,
      pickupStopId: sample.direction === 'tbilisi-gori' ? stop.id : null,
      pickupStopName: sample.direction === 'tbilisi-gori' ? stop.name : null,
      didubeName: config.didubeName, didubeAddress: config.didubeAddress,
      requestedDate: date, requestedTime: sample.time,
      assignedDate: status === 'confirmed' ? date : null, assignedTime: status === 'confirmed' ? sample.time : null,
      status, deletedAt: sample.deleted ? `${day}T09:00:00+04:00` : null,
      createdAt: `${day}T06:00:00+04:00`, updatedAt: `${day}T07:00:00+04:00`,
    };
  });
}

function matchesSearch(name: string, phone: string, search: string) {
  const digits = search.replace(/\D/g, '');
  return !search || name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || phone.includes(search) || (!!digits && phone.replace(/\D/g, '').includes(digits));
}

function filteredBookings(bookings: Booking[], params: URLSearchParams) {
  const scope = params.get('scope') ?? 'all';
  return bookings.filter(booking => {
    const date = booking.assignedDate ?? booking.requestedDate;
    const time = booking.assignedTime ?? booking.requestedTime;
    return (scope === 'deleted' ? !!booking.deletedAt : !booking.deletedAt)
      && (scope !== 'incoming' || booking.status === 'waiting')
      && (scope !== 'scheduled' || booking.status === 'confirmed')
      && (!params.get('direction') || booking.direction === params.get('direction'))
      && (!params.get('date') || date === params.get('date'))
      && (!params.get('time') || time === params.get('time'))
      && matchesSearch(booking.name, booking.phone, params.get('search') ?? '');
  });
}

function schedule(bookings: Booking[], params: URLSearchParams): Schedule {
  const direction: Direction = params.get('direction') === 'tbilisi-gori' ? 'tbilisi-gori' : 'gori-tbilisi';
  const date = params.get('date') ?? today();
  return {
    direction, date, baseTimes, overrideTimes: null,
    slots: baseTimes.map(time => {
      const rows = bookings.filter(booking => !booking.deletedAt && booking.status === 'confirmed' && booking.direction === direction && booking.assignedDate === date && booking.assignedTime === time);
      return { time, active: true, bookingCount: rows.length, seatCount: rows.reduce((total, row) => total + row.seats, 0) };
    }),
  };
}

function passengers(bookings: Booking[], search: string): Passenger[] {
  const groups = new Map<string, Passenger>();
  for (const row of bookings.filter(booking => !booking.deletedAt)) {
    const date = row.assignedDate ?? row.requestedDate;
    const passenger = groups.get(row.phone) ?? { name: row.name, phone: row.phone, orderCount: 0, seats: 0, latestDate: date };
    passenger.orderCount++;
    passenger.seats += row.seats;
    if (date > passenger.latestDate) passenger.latestDate = date;
    groups.set(row.phone, passenger);
  }
  return [...groups.values()].filter(row => matchesSearch(row.name, row.phone, search));
}

function passengerProfile(bookings: Booking[], phone: string): PassengerProfile | null {
  const canonicalPhone = canonicalPassengerPhone(phone);
  if (!canonicalPhone) return null;
  const booking = bookings.find(row => !row.deletedAt && row.status === 'confirmed' && canonicalPassengerPhone(row.phone) === canonicalPhone);
  return booking ? {
    phone: canonicalPhone, name: booking.name, goriAddress: booking.goriAddress,
    goriPickupAddress: bookings.find(row => row.status === 'confirmed' && row.direction === 'gori-tbilisi' && canonicalPassengerPhone(row.phone) === canonicalPhone)?.goriAddress ?? '',
    pickupStopId: booking.pickupStopId, pickupStopName: booking.pickupStopName, updatedAt: booking.updatedAt,
  } : null;
}

function analytics(bookings: Booking[], params: URLSearchParams): Analytics {
  const rows = bookings.filter(row => {
    const day = row.assignedDate ?? row.requestedDate;
    return day >= (params.get('from') ?? '0001-01-01') && day <= (params.get('to') ?? '9999-12-31');
  });
  const active = rows.filter(row => !row.deletedAt);
  const days = new Map<string, { date: string; orders: number; seats: number }>();
  for (const row of active) {
    const date = row.assignedDate ?? row.requestedDate;
    const day = days.get(date) ?? { date, orders: 0, seats: 0 };
    day.orders++; day.seats += row.seats; days.set(date, day);
  }
  return {
    totals: { incoming: active.filter(row => row.status === 'waiting').length, confirmed: active.filter(row => row.status === 'confirmed').length, deleted: rows.filter(row => row.deletedAt).length, seats: active.reduce((sum, row) => sum + row.seats, 0) },
    directions: directionList.map(direction => {
      const directionRows = active.filter(row => row.direction === direction);
      return { direction, orders: directionRows.length, seats: directionRows.reduce((sum, row) => sum + row.seats, 0) };
    }),
    days: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
  };
}

/** Only the standalone preview entry calls this. There is deliberately no network fallback. */
export function installPreviewApi(): void {
  const day = today();
  const bookings = sampleBookings(day);
  const caller = bookings.find(booking => booking.direction === 'gori-tbilisi' && booking.status === 'confirmed')!;
  const sampleCall: CallInquiry = { id: 1, phone: caller.phone, occurredAt: `${day}T08:00:00+04:00`, durationSeconds: 0, phase: 'answered', passengerProfile: passengerProfile(bookings, caller.phone), deviceName: 'სატესტო Redmi — რეალური ზარი არ არის', createdAt: `${day}T08:00:00+04:00`, deletedAt: null, bookingId: null };
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const isRequest = input instanceof Request;
    const signal = init?.signal ?? (isRequest ? input.signal : undefined);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return reply({ error: previewOnlyMessage, code: 'PREVIEW_ONLY' }, 409);
    const url = new URL(isRequest ? input.url : String(input), 'https://preview.invalid');
    const params = url.searchParams;
    switch (url.pathname) {
      case '/api/auth/session': return reply({ user: previewUser, needsSetup: false });
      case '/api/public/config': return reply(config);
      case '/api/public/slots': return reply({ slots: schedule(bookings, params).slots.filter(slot => new Date(`${params.get('date') ?? day}T${slot.time}:00+04:00`).getTime() > Date.now()) });
      case '/api/admin/bookings': return reply({ bookings: filteredBookings(bookings, params) });
      case '/api/admin/schedule': return reply(schedule(bookings, params));
      case '/api/admin/calls': return reply({ calls: (params.get('scope') ?? 'incoming') === 'incoming' && matchesSearch(sampleCall.passengerProfile?.name || '', sampleCall.phone || '', params.get('search') ?? '') ? [sampleCall] : [] });
      case '/api/admin/devices': return reply({ devices: [] });
      case '/api/admin/settings': return reply({ didubeName: config.didubeName, didubeAddress: config.didubeAddress });
      case '/api/admin/stops': return reply({ stops: config.stops });
      case '/api/admin/staff': return reply({ users: [previewUser] });
      case '/api/admin/passengers/profile': return reply({ profile: passengerProfile(bookings, params.get('phone') ?? '') });
      case '/api/admin/passengers': return reply({ passengers: passengers(bookings, params.get('search') ?? '') });
      case '/api/admin/analytics': return reply(analytics(bookings, params));
      default: return reply({ error: previewOnlyMessage, code: 'PREVIEW_ONLY' }, 404);
    }
  };
}
