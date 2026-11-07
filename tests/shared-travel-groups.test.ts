import assert from 'node:assert/strict';
import test from 'node:test';
import { groupTravelBookings, type TravelGroupBooking } from '../shared/travel-groups.js';

function booking(id: number, changes: Partial<TravelGroupBooking> = {}): TravelGroupBooking {
  return { id, direction: 'gori-tbilisi', date: '2030-01-02', time: '09:30', bookingType: 'passenger', ...changes };
}

test('an explicit compatible party forms one stable block without mutating or merging its records', () => {
  const first = booking(1, { travelGroupId: 'party-a', travelGroupOrder: 0 });
  const second = booking(3, { travelGroupId: 'party-a', travelGroupOrder: 1, bookingType: 'parcel' });
  const independent = booking(2);
  const input = [first, independent, second];
  const result = groupTravelBookings(input);
  assert.deepEqual(result.map(group => ({ ids: group.bookings.map(row => row.id), grouped: group.grouped })), [
    { ids: [1, 3], grouped: true }, { ids: [2], grouped: false },
  ]);
  assert.equal(result[0].bookings[0], first);
  assert.equal(result[0].bookings[1], second);
  assert.deepEqual(input.map(row => row.id), [1, 2, 3]);
});

test('other batches, trips, directions, cancelled or waiting members and whole cars cannot create a same-car cue', () => {
  const original = booking(1, { travelGroupId: 'party-a' });
  for (const changes of [
    { travelGroupId: 'party-b' }, { date: '2030-01-03' }, { time: '14:00' },
    { direction: 'tbilisi-gori' }, { deletedAt: '2030-01-01' }, { status: 'waiting' },
    { bookingType: 'whole_car' }, { travelGroupId: null },
  ]) assert.deepEqual(groupTravelBookings([original, booking(2, { travelGroupId: 'party-a', ...changes })])
    .map(group => group.grouped), [false, false]);
  assert.equal(groupTravelBookings([booking(1), booking(2)])[0].grouped, false);
});

test('assigned trip fields govern admin rows, and hidden members never produce a partial group or leaked numbering', () => {
  const first = booking(1, { date: undefined, time: undefined, assignedDate: '2030-01-03', assignedTime: '14:00', requestedDate: '2030-01-02', requestedTime: '09:30', status: 'confirmed', deletedAt: null, travelGroupId: 'party-a', travelGroupOrder: 4 });
  const second = booking(2, { date: undefined, time: undefined, assignedDate: '2030-01-03', assignedTime: '14:00', requestedDate: '2030-01-02', requestedTime: '09:30', status: 'confirmed', deletedAt: null, travelGroupId: 'party-a', travelGroupOrder: 6 });
  assert.equal(groupTravelBookings([first])[0].grouped, false);
  assert.deepEqual(groupTravelBookings([second, first])[0].bookings.map(row => row.id), [1, 2]);
  assert.equal(groupTravelBookings([first, { ...second, assignedTime: '15:00' }]).length, 2);
  assert.equal(groupTravelBookings([{ ...first, bookingType: 'whole_car' }, { ...second, bookingType: 'whole_car' }]).length, 2);
});
