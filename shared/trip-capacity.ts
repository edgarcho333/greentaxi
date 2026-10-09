export type CapacityDriver = Readonly<{ key: string; name: string; capacity: number; active?: boolean }>;

/** Seat totals are a visual grouping, never an assignment of a passenger to a car. */
export function calculateTripCapacity<T extends CapacityDriver>(drivers: readonly T[], bookedSeats: number) {
  if (!Number.isSafeInteger(bookedSeats) || bookedSeats < 0) throw new RangeError('Invalid booked seat total.');
  if (drivers.some(driver => !Number.isSafeInteger(driver.capacity) || driver.capacity < 1 || driver.capacity > 8)) throw new RangeError('Invalid car capacity.');
  if (new Set(drivers.map(driver => driver.key)).size !== drivers.length) throw new RangeError('Duplicate trip driver.');
  let remaining = bookedSeats;
  const cars = drivers.map(driver => {
    if (driver.active === false) return { ...driver, filledSeats: 0, freeSeats: 0 };
    const filledSeats = Math.min(driver.capacity, remaining);
    remaining -= filledSeats;
    return { ...driver, filledSeats, freeSeats: driver.capacity - filledSeats };
  });
  const totalSeats = cars.reduce((sum, driver) => sum + (driver.active === false ? 0 : driver.capacity), 0);
  return { drivers: cars, bookedSeats, totalSeats, freeSeats: Math.max(totalSeats - bookedSeats, 0), uncoveredSeats: remaining };
}
