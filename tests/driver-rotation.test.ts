import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableDriverQueue, buildDriverSchedule, calendarDateOrdinal, INITIAL_DRIVER_ROSTER, rotateDriverQueue, type DriverDayOverride } from '../shared/driver-rotation.js';

const ANCHOR = '2026-10-09';
const SCHEDULE_ANCHOR = '2026-10-19';

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

test('an ordered queue advances one position, preserves everyone and wraps after 43 days', () => {
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

test('daily queue includes configured departures without automatically assigning any driver', () => {
  const result = buildDriverSchedule(SCHEDULE_ANCHOR, ['22:15', '09:30', '06:00', '07:00', '08:00', '08:30', '09:00', '06:00']);
  assert.equal(result.direction, 'gori-tbilisi');
  assert.equal(result.anchorDate, SCHEDULE_ANCHOR);
  assert.equal(result.firstDriverId, 32);
  assert.deepEqual(result.times, ['06:00', '07:00', '08:00', '08:30', '09:00', '09:30', '22:15']);
  assert.ok(result.drivers.every(driver => driver.assignedTime === null && driver.automaticTime === null && !driver.assignmentActive));
  assert.deepEqual(result.drivers.map(driver => driver.queuePosition), Array.from({ length: 43 }, (_, index) => index + 1));
});

test('the confirmed October dates traverse the roster bottom to top and wrap without changing identities', () => {
  const expected = [...Array.from({ length: 32 }, (_, index) => 32 - index), ...Array.from({ length: 11 }, (_, index) => 43 - index)];
  const first = buildDriverSchedule(SCHEDULE_ANCHOR, []);
  assert.deepEqual(first.drivers.map(driver => driver.id), expected);
  for (const [date, id, name] of [
    ['2026-10-18', 33, 'გელა'], ['2026-10-19', 32, 'სუხიტა'], ['2026-10-20', 31, 'გურამი'],
    ['2026-10-21', 30, 'ერასტი'], ['2026-11-19', 1, 'რეზო'], ['2026-11-20', 43, 'ლაშა / ვიქტორი'],
    ['2026-12-01', 32, 'სუხიტა'],
  ] as const) {
    const schedule = buildDriverSchedule(date, []);
    assert.equal(schedule.firstDriverId, id, date);
    assert.equal(schedule.drivers[0].name, name, date);
    assert.equal(new Set(schedule.drivers.map(driver => driver.id)).size, 43);
    assert.deepEqual(schedule.drivers.map(driver => driver.queuePosition), Array.from({ length: 43 }, (_, index) => index + 1));
    for (const driver of schedule.drivers) {
      const stored = INITIAL_DRIVER_ROSTER.find(entry => entry.id === driver.id)!;
      assert.deepEqual([driver.name, driver.capacity, driver.order], [stored.name, stored.capacity, stored.order]);
    }
  }
  assert.deepEqual(buildDriverSchedule('2026-12-01', []).drivers, first.drivers);
});

test('explicit trip choices allow several drivers together and leave every other driver unassigned', () => {
  const overrides: DriverDayOverride[] = [
    { driverId: 1, declined: false, assignmentMode: 'manual', manualTime: '08:00' },
    { driverId: 2, declined: false, assignmentMode: 'manual', manualTime: '08:00' },
    { driverId: 4, declined: false, assignmentMode: 'manual', manualTime: null },
    { driverId: 5, declined: false, assignmentMode: 'auto', manualTime: null },
  ];
  const result = buildDriverSchedule(SCHEDULE_ANCHOR, ['06:00', '07:00', '08:00', '09:00', '10:00'], INITIAL_DRIVER_ROSTER, overrides);
  assert.ok(result.drivers.every(driver => driver.automaticTime === null));
  assert.deepEqual(result.drivers.filter(driver => driver.assignedTime !== null).map(driver => driver.id).sort((a, b) => a - b), [1, 2]);
  assert.ok(result.drivers.filter(driver => [1, 2].includes(driver.id)).every(driver => driver.assignedTime === '08:00' && driver.assignmentActive));
  assert.equal(result.drivers.find(driver => driver.id === 4)?.assignmentActive, false);
});

test('refusals never assign other drivers and retain explicit trip choices and next day rotation', () => {
  const overrides: DriverDayOverride[] = [
    { driverId: 1, declined: true, assignmentMode: 'manual', manualTime: '10:00' },
    { driverId: 3, declined: false, assignmentMode: 'manual', manualTime: '10:00' },
  ];
  const times = ['06:00', '07:00', '08:00', '10:00'];
  const result = buildDriverSchedule(SCHEDULE_ANCHOR, times, INITIAL_DRIVER_ROSTER, overrides);
  assert.equal(result.firstDriverId, 32);
  assert.equal(result.drivers.find(driver => driver.id === 1)?.assignedTime, null);
  assert.deepEqual(result.drivers.filter(driver => driver.assignedTime !== null).map(driver => [driver.id, driver.assignedTime]), [[3, '10:00']]);
  assert.ok(result.drivers.every(driver => driver.automaticTime === null));
  const restored = buildDriverSchedule(SCHEDULE_ANCHOR, times, INITIAL_DRIVER_ROSTER, overrides.map(override => ({ ...override, declined: false })));
  assert.equal(restored.drivers.find(driver => driver.id === 1)?.assignedTime, '10:00');
  assert.equal(restored.drivers.find(driver => driver.id === 2)?.assignedTime, null);
  const tomorrow = buildDriverSchedule('2026-10-20', times);
  assert.equal(tomorrow.firstDriverId, 31);
  assert.equal(tomorrow.drivers.at(-1)?.id, 32);
  assert.ok(tomorrow.drivers.every(driver => driver.assignedTime === null));
});

test('removed departure times retain explicit choices as inactive without generating replacements', () => {
  const result = buildDriverSchedule(SCHEDULE_ANCHOR, ['07:00'], INITIAL_DRIVER_ROSTER, [{ driverId: 1, declined: false, assignmentMode: 'manual', manualTime: '06:00' }]);
  const assigned = result.drivers.find(driver => driver.id === 1)!;
  assert.equal(assigned.automaticTime, null);
  assert.equal(assigned.assignedTime, '06:00');
  assert.equal(assigned.assignmentActive, false);
  assert.equal(assigned.assignmentMode, 'manual');
  assert.ok(buildDriverSchedule(SCHEDULE_ANCHOR, []).drivers.every(driver => driver.assignedTime === null && !driver.assignmentActive));
  assert.throws(() => buildDriverSchedule(SCHEDULE_ANCHOR, ['24:00']), RangeError);
  assert.throws(() => buildDriverSchedule(SCHEDULE_ANCHOR, ['6:00']), RangeError);
});
