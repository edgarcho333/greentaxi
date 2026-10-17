-- Departure hours now belong only to explicit trip assignments. Retain existing
-- whole-car bookings before legacy automatic projections stop being interpreted.
-- Never overwrite an explicit choice, daily refusal, or conflicting reservation.
CREATE TEMP TABLE _manual_driver_assignment_guard (
  valid INTEGER NOT NULL CHECK(valid=1)
);
INSERT INTO _manual_driver_assignment_guard
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM bookings booking
  LEFT JOIN drivers driver ON booking.assigned_vehicle_key='roster:' || CAST(driver.id AS TEXT)
  LEFT JOIN driver_day_overrides preference ON preference.driver_id=driver.id AND preference.date=booking.assigned_date
  WHERE booking.direction='gori-tbilisi' AND booking.booking_type='whole_car'
    AND booking.status='confirmed' AND booking.deleted_at IS NULL
    AND booking.assigned_vehicle_key LIKE 'roster:%'
    AND (driver.id IS NULL OR preference.declined=1 OR
      (preference.assignment_mode='manual' AND (preference.manual_time IS NULL OR preference.manual_time<>booking.assigned_time)))
) OR EXISTS (
  SELECT 1 FROM bookings
  WHERE direction='gori-tbilisi' AND booking_type='whole_car' AND status='confirmed'
    AND deleted_at IS NULL AND assigned_vehicle_key LIKE 'roster:%'
  GROUP BY assigned_vehicle_key,assigned_date
  HAVING COUNT(*)>1
) THEN 0 ELSE 1 END;
DROP TABLE _manual_driver_assignment_guard;

INSERT INTO driver_day_overrides(driver_id,date,declined,assignment_mode,manual_time,updated_at)
SELECT driver.id,booking.assigned_date,0,'manual',MIN(booking.assigned_time),MAX(booking.updated_at)
FROM bookings booking
JOIN drivers driver ON booking.assigned_vehicle_key='roster:' || CAST(driver.id AS TEXT)
LEFT JOIN driver_day_overrides preference ON preference.driver_id=driver.id AND preference.date=booking.assigned_date
WHERE booking.direction='gori-tbilisi' AND booking.booking_type='whole_car'
  AND booking.status='confirmed' AND booking.deleted_at IS NULL
  AND (preference.driver_id IS NULL OR preference.assignment_mode='auto')
GROUP BY driver.id,booking.assigned_date
ON CONFLICT(driver_id,date) DO UPDATE SET assignment_mode='manual',manual_time=excluded.manual_time;

