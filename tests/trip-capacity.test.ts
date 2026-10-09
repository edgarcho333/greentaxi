import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTripCapacity } from '../shared/trip-capacity.js';

test('trip capacity fills seven-seat cars in order using seats rather than number of orders', () => {
  const drivers = [{ key: 'roster:1', name: 'First', capacity: 7 }, { key: 'roster:2', name: 'Second', capacity: 7 }];
  const nine = calculateTripCapacity(drivers, 9);
  assert.deepEqual(nine.drivers.map(driver => [driver.filledSeats, driver.freeSeats]), [[7, 0], [2, 5]]);
  assert.deepEqual([nine.totalSeats, nine.bookedSeats, nine.freeSeats, nine.uncoveredSeats], [14, 9, 5, 0]);
  assert.deepEqual(calculateTripCapacity(drivers, 14).drivers.map(driver => driver.filledSeats), [7, 7]);
  assert.deepEqual(drivers.map(driver => Object.keys(driver)), [['key', 'name', 'capacity'], ['key', 'name', 'capacity']]);
});

test('missing cars and overbooked trips retain explicit uncovered seats without negative availability', () => {
  const noCars = calculateTripCapacity([], 8);
  assert.deepEqual([noCars.totalSeats, noCars.freeSeats, noCars.uncoveredSeats], [0, 0, 8]);
  const excess = calculateTripCapacity([{ key: 'temporary:1', name: 'One-off', capacity: 6 }], 8);
  assert.deepEqual([excess.drivers[0].filledSeats, excess.totalSeats, excess.freeSeats, excess.uncoveredSeats], [6, 6, 0, 2]);
  assert.deepEqual(calculateTripCapacity([], 0), { drivers: [], bookedSeats: 0, totalSeats: 0, freeSeats: 0, uncoveredSeats: 0 });
});

test('retained cars on disabled times never contribute to available capacity', () => {
  const result = calculateTripCapacity([
    { key: 'roster:1', name: 'Inactive retained', capacity: 7, active: false },
    { key: 'temporary:1', name: 'Active', capacity: 6, active: true },
  ], 8);
  assert.deepEqual(result.drivers.map(driver => [driver.filledSeats, driver.freeSeats]), [[0, 0], [6, 0]]);
  assert.deepEqual([result.totalSeats, result.freeSeats, result.uncoveredSeats], [6, 0, 2]);
});

test('invalid or duplicate capacity inputs are rejected rather than fabricating availability', () => {
  for (const booked of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => calculateTripCapacity([], booked), RangeError);
  for (const capacity of [0, 9, 1.5, NaN]) assert.throws(() => calculateTripCapacity([{ key: 'one', name: 'Test', capacity }], 0), RangeError);
  assert.throws(() => calculateTripCapacity([{ key: 'one', name: 'First', capacity: 7 }, { key: 'one', name: 'Duplicate', capacity: 7 }], 1), RangeError);
});
