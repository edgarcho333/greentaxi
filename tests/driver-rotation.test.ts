import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableDriverQueue, buildDriverSchedule, calendarDateOrdinal, INITIAL_DRIVER_ROSTER, rotateDriverQueue, type DriverDayOverride } from '../shared/driver-rotation.js';

const ANCHOR = '2026-10-09';

test('initial driver roster preserves all 43 provided labels, capacities and stable positions', () => {
  assert.deepEqual(INITIAL_DRIVER_ROSTER.map(driver => driver.name), [
    'რეზო', 'კუდუხა', 'გოჩა', 'ვიქტორი', 'ბიძინა', 'დიმა', 'გუგა', 'ამიკო', 'ნიკა', 'გიგა',
    'ვანო', 'გიორგი', 'შოშია', 'ლევანი', 'დოლიმე', 'კობა', 'ბოლოთა', 'ბუზა', 'ზურა', 'ედიკა',
    'კახა ახალი', 'ბორა', 'თემო ახალი', 'ფურცელა', 'ბადრი', 'რამაზი', 'ვალერი', 'დათო ტინის ხიდი',
    'დათო ტინის ხიდი ახალი', 'ერასტი', 'გურამი', 'სუხიტა', 'გელა', 'სოსო', 'აჩიკო', 'ირაკლი',
    'კევა', 'ზვიადი', 'სვანი', 'დევი', 'ილარიონო', 'გია', 'ლაშა / ვიქტორი',
  ]);
  assert.deepEqual(INITIAL_DRIVER_ROSTER.map(driver => driver.capacity), [
    7, 7, 8, 7, 6, 7, 7, 6, 6, 6, 7, 7, 7, 6, 7, 6, 7, 7, 7, 7, 7, 7, 7, 7, 6,
    7, 7, 7, 7, 7, 7, 7, 6, 8, 7, 7, 6, 7, 6, 6, 7, 8, 7,
  ]);
  assert.deepEqual(INITIAL_DRIVER_ROSTER.map(driver => driver.id), Array.from({ length: 43 }, (_, index) => index + 1));
  assert.deepEqual(INITIAL_DRIVER_ROSTER.map(driver => driver.order), Array.from({ length: 43 }, (_, index) => index + 1));
  assert.equal(INITIAL_DRIVER_ROSTER.reduce((total, driver) => total + driver.capacity, 0), 293);
  assert.equal(new Set(INITIAL_DRIVER_ROSTER.map(driver => driver.name)).size, 43);
});

test('daily rotation advances one position, preserves everyone and wraps after 43 days', () => {
  assert.deepEqual(rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, ANCHOR), INITIAL_DRIVER_ROSTER);
  const tomorrow = rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2026-10-10');
  assert.equal(tomorrow[0].name, 'კუდუხა');
  assert.equal(tomorrow[1].name, 'გოჩა');
  assert.equal(tomorrow.at(-1)?.name, 'რეზო');
  assert.equal(new Set(tomorrow.map(driver => driver.id)).size, 43);
  assert.equal(rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2026-11-20')[0].name, 'ლაშა / ვიქტორი');
  assert.deepEqual(rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2026-11-21'), INITIAL_DRIVER_ROSTER);
  assert.deepEqual(rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2027-01-03'), INITIAL_DRIVER_ROSTER);
});

test('rotation supports dates before the anchor and does not mutate the permanent queue', () => {
  const original = INITIAL_DRIVER_ROSTER.map(driver => ({ ...driver }));
  const previous = rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2026-10-08');
  assert.equal(previous[0].id, 43);
  assert.equal(previous[1].id, 1);
  previous.reverse();
  assert.deepEqual(INITIAL_DRIVER_ROSTER, original);
  assert.deepEqual(rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, '2026-08-27'), INITIAL_DRIVER_ROSTER);
});

test('calendar rotation counts leap days and year boundaries independently of timezone', () => {
  assert.equal(calendarDateOrdinal('2024-03-01') - calendarDateOrdinal('2024-02-28'), 2);
  assert.equal(calendarDateOrdinal('2023-03-01') - calendarDateOrdinal('2023-02-28'), 1);
  assert.equal(calendarDateOrdinal('2027-01-02') - calendarDateOrdinal('2026-12-31'), 2);
  assert.equal(rotateDriverQueue(INITIAL_DRIVER_ROSTER, '2024-02-28', '2024-03-01')[0].id, 3);
  assert.equal(rotateDriverQueue(INITIAL_DRIVER_ROSTER, '2026-12-31', '2027-01-02')[0].id, 3);
});

test('refusals skip drivers for that day while the next date still starts at its base position', () => {
  const drivers = INITIAL_DRIVER_ROSTER.slice(0, 3);
  const todayDeclined = new Set([1, 2]);
  assert.deepEqual(availableDriverQueue(drivers, ANCHOR, ANCHOR, todayDeclined).map(driver => driver.id), [3]);
  assert.deepEqual(availableDriverQueue(drivers, ANCHOR, '2026-10-10', new Set()).map(driver => driver.id), [2, 3, 1]);
  assert.deepEqual(availableDriverQueue(drivers, ANCHOR, '2026-10-10', new Set([2])).map(driver => driver.id), [3, 1]);
  assert.deepEqual(availableDriverQueue(drivers, ANCHOR, '2026-10-11', new Set()).map(driver => driver.id), [3, 1, 2]);
  assert.deepEqual(drivers.map(driver => driver.id), [1, 2, 3]);
  assert.deepEqual([...todayDeclined], [1, 2]);
});

test('empty and fully declined queues remain empty without producing a substitute driver', () => {
  assert.deepEqual(rotateDriverQueue([], ANCHOR, '2026-10-10'), []);
  assert.deepEqual(availableDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, ANCHOR, new Set(INITIAL_DRIVER_ROSTER.map(driver => driver.id))), []);
  assert.deepEqual(availableDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, ANCHOR, new Set([999])), INITIAL_DRIVER_ROSTER);
});

test('invalid calendar dates cannot silently change the rotation', () => {
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-10-32', '2026-10-9', '09/10/2026', '2026-10-09T00:00:00Z', '']) {
    assert.throws(() => calendarDateOrdinal(date), RangeError, date);
    assert.throws(() => rotateDriverQueue(INITIAL_DRIVER_ROSTER, ANCHOR, date), RangeError, date);
    assert.throws(() => rotateDriverQueue([], date, ANCHOR), RangeError, date);
  }
  assert.equal(calendarDateOrdinal('2000-02-29') - calendarDateOrdinal('2000-02-28'), 1);
  assert.throws(() => calendarDateOrdinal('1900-02-29'), RangeError);
});

test('daily plans include half-hour and custom times with remaining drivers in reserve', () => {
  const result = buildDriverSchedule(ANCHOR, ['22:15', '09:30', '06:00', '07:00', '08:00', '08:30', '09:00', '06:00']);
  assert.equal(result.direction, 'gori-tbilisi');
  assert.equal(result.anchorDate, ANCHOR);
  assert.equal(result.firstDriverId, 1);
  assert.deepEqual(result.times, ['06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '22:15']);
  assert.deepEqual(result.drivers.slice(0, 7).map(driver => driver.assignedTime), result.times);
  assert.equal(result.drivers[3].name, 'ვიქტორი');
  assert.equal(result.drivers[3].assignedTime, '08:30');
  assert.ok(result.drivers.slice(7).every(driver => driver.assignedTime === null && !driver.assignmentActive));
  assert.deepEqual(result.drivers.map(driver => driver.queuePosition), Array.from({ length: 43 }, (_, index) => index + 1));
});

test('manual times allow several drivers together and do not move others automatic positions', () => {
  const overrides: DriverDayOverride[] = [
    { driverId: 1, declined: false, assignmentMode: 'manual', manualTime: '08:00' },
    { driverId: 2, declined: false, assignmentMode: 'manual', manualTime: '08:00' },
    { driverId: 4, declined: false, assignmentMode: 'manual', manualTime: null },
  ];
  const result = buildDriverSchedule(ANCHOR, ['06:00', '07:00', '08:00', '09:00', '10:00'], INITIAL_DRIVER_ROSTER, overrides);
  assert.deepEqual(result.drivers.slice(0, 5).map(driver => driver.automaticTime), ['06:00', '07:00', '08:00', '09:00', '10:00']);
  assert.deepEqual(result.drivers.slice(0, 5).map(driver => driver.assignedTime), ['08:00', '08:00', '08:00', null, '10:00']);
  assert.equal(result.drivers[3].assignmentMode, 'manual');
  assert.equal(result.drivers[3].assignmentActive, false);
  assert.equal(result.drivers[0].assignmentActive, true);
});

test('refusals compress automatic times but retain manual preferences and the next day rotation', () => {
  const overrides: DriverDayOverride[] = [
    { driverId: 1, declined: true, assignmentMode: 'manual', manualTime: '10:00' },
    { driverId: 3, declined: false, assignmentMode: 'manual', manualTime: '10:00' },
  ];
  const times = ['06:00', '07:00', '08:00', '10:00'];
  const result = buildDriverSchedule(ANCHOR, times, INITIAL_DRIVER_ROSTER, overrides);
  assert.equal(result.firstDriverId, 1);
  assert.equal(result.drivers[0].assignedTime, null);
  assert.equal(result.drivers[0].automaticTime, null);
  assert.equal(result.drivers[0].assignmentMode, 'manual');
  assert.equal(result.drivers[1].assignedTime, '06:00');
  assert.equal(result.drivers[2].automaticTime, '07:00');
  assert.equal(result.drivers[2].assignedTime, '10:00');
  assert.equal(result.drivers[3].assignedTime, '08:00');
  const restored = buildDriverSchedule(ANCHOR, times, INITIAL_DRIVER_ROSTER, overrides.map(override => ({ ...override, declined: false })));
  assert.equal(restored.drivers[0].assignedTime, '10:00');
  assert.equal(restored.drivers[1].assignedTime, '07:00');
  const tomorrow = buildDriverSchedule('2026-10-10', times);
  assert.equal(tomorrow.firstDriverId, 2);
  assert.equal(tomorrow.drivers[0].assignedTime, '06:00');
  assert.equal(tomorrow.drivers.at(-1)?.id, 1);
  assert.equal(tomorrow.drivers.at(-1)?.assignmentMode, 'auto');
});

test('removed manual times stay visible as inactive while empty schedules produce reserves', () => {
  const result = buildDriverSchedule(ANCHOR, ['07:00'], INITIAL_DRIVER_ROSTER, [{ driverId: 1, declined: false, assignmentMode: 'manual', manualTime: '06:00' }]);
  assert.equal(result.drivers[0].automaticTime, '07:00');
  assert.equal(result.drivers[0].assignedTime, '06:00');
  assert.equal(result.drivers[0].assignmentActive, false);
  assert.equal(result.drivers[0].assignmentMode, 'manual');
  assert.ok(buildDriverSchedule(ANCHOR, []).drivers.every(driver => driver.assignedTime === null && !driver.assignmentActive));
  assert.throws(() => buildDriverSchedule(ANCHOR, ['24:00']), RangeError);
  assert.throws(() => buildDriverSchedule(ANCHOR, ['6:00']), RangeError);
});
