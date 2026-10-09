import assert from 'node:assert/strict';
import test from 'node:test';
import type { Booking } from '../src/api.js';
import { passengerDepartureTimes } from '../shared/passenger-departure-times.js';

type History = Parameters<typeof passengerDepartureTimes>[0][number];
function history(day: string, time: string, overrides: Partial<History & Pick<Booking, 'seats' | 'id'>> = {}): History {
  return { direction: 'gori-tbilisi', status: 'confirmed', deletedAt: null,
    requestedDate: day, requestedTime: time, assignedDate: day, assignedTime: time, ...overrides };
}

test('departure suggestions rank order frequency before chronology, break ties by actual slot and isolate directions', () => {
  const rows = [
    history('2026-10-07', '08:30', { id: 9, seats: 1 }),
    history('2029-12-28', '08:30', { id: 8, seats: 1 }),
    history('2029-12-29', '10:00', { id: 7, seats: 8 }),
    history('2029-12-30', '08:30', { id: 6, seats: 1 }),
    history('2029-12-31', '10:00', { id: 5, seats: 8 }),
    history('2029-12-30', '12:00', { id: 999 }),
    history('2029-12-31', '09:30', { id: 1 }),
    history('2029-12-28', '14:00', { direction: 'tbilisi-gori' }),
    history('2029-12-29', '14:00', { direction: 'tbilisi-gori' }),
    history('2029-12-31', '08:30', { direction: 'tbilisi-gori' }),
  ];
  const ranked = passengerDepartureTimes(rows, new Date('2030-01-01T00:00:00Z'));
  assert.deepEqual(ranked, { 'gori-tbilisi': ['08:30', '10:00', '09:30', '12:00'], 'tbilisi-gori': ['14:00', '08:30'] });
  assert.deepEqual(passengerDepartureTimes([...rows].reverse(), new Date('2030-01-01T00:00:00Z')), ranked);
});

test('departure suggestions honor Tbilisi cutoff, effective slots, strict calendar dates and confirmed active history only', () => {
  const now = new Date('2030-01-01T00:00:00Z'); // 04:00 in Tbilisi, after its midnight rollover.
  const rows = [
    history('2030-01-01', '03:59'),
    history('2030-01-01', '04:00'),
    history('2030-01-01', '04:01'),
    history('2030-01-02', '05:00'),
    history('2029-12-31', '18:00', { assignedDate: '2029-12-30', assignedTime: '13:45' }),
    history('2029-12-31', '17:45', { assignedDate: null, assignedTime: null }),
    history('2029-12-31', '20:00', { status: 'waiting', assignedDate: null, assignedTime: null }),
    history('2029-12-31', '21:00', { deletedAt: '2029-12-31T00:00:00Z' }),
    history('2029-02-30', '11:00'),
    history('2029-02-29', '11:00'),
    history('2028-02-29', '08:30'),
    history('2029-13-01', '11:00'),
    history('2029-12-31', '9:00'),
    history('2029-12-31', '09:60'),
    history('2029-12-31', '24:00'),
    history('2029-12-31suffix', '10:00'),
  ];
  assert.deepEqual(passengerDepartureTimes(rows, now), { 'gori-tbilisi': ['03:59', '17:45', '13:45', '08:30'], 'tbilisi-gori': [] });
  assert.deepEqual(passengerDepartureTimes(rows, new Date('invalid')), { 'gori-tbilisi': [], 'tbilisi-gori': [] });
});

test('departure suggestions retain every historical hourly, half-hour and custom departure without truncation', () => {
  const times = [...Array.from({ length: 16 }, (_, index) => `${String(index + 6).padStart(2, '0')}:00`), '08:30', '09:30', '17:45'];
  const ranked = passengerDepartureTimes(times.map(time => history('2029-12-31', time)), new Date('2030-01-01T00:00:00Z'));
  assert.equal(ranked['gori-tbilisi'].length, 19);
  assert.deepEqual(ranked['gori-tbilisi'], [...times].sort().reverse());
});
