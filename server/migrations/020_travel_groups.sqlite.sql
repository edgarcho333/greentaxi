-- Co-travellers retain separate booking, contact, address and seat records.
ALTER TABLE bookings ADD COLUMN travel_group_id TEXT;
ALTER TABLE bookings ADD COLUMN travel_group_order INTEGER
  CHECK(travel_group_order IS NULL OR travel_group_order>=0);

-- Recover only creation batches proven by durable call links or successful
-- manual-group receipts. No inference from phone numbers, addresses or dates.
WITH
manual_receipts AS MATERIALIZED (
  SELECT 'manual:'||length(scope)||':'||scope||':'||length(key)||':'||key AS source_key,
    CASE WHEN json_valid(response) THEN response ELSE '{}' END AS payload
  FROM idempotency
  WHERE scope LIKE 'employee-booking-group:%' AND status>=200 AND status<300
    AND substr(scope,length('employee-booking-group:')+1)<>''
    AND substr(scope,length('employee-booking-group:')+1) NOT GLOB '*[^0-9]*'
), manual_objects AS (
  SELECT receipt.source_key,receipt.payload,CAST(item.key AS INTEGER) AS member_order,
    CASE WHEN item.type='object' THEN item.value ELSE '{}' END AS member
  FROM manual_receipts receipt
  JOIN json_each(CASE WHEN json_type(receipt.payload,'$.bookings')='array'
    THEN json_extract(receipt.payload,'$.bookings') ELSE '[]' END) item
  WHERE json_array_length(receipt.payload,'$.bookings')>=2
), manual_members AS (
  SELECT object.source_key,object.payload,object.member_order,booking.id AS booking_id
  FROM manual_objects object JOIN bookings booking ON booking.id=json_extract(object.member,'$.id')
  WHERE json_type(object.member,'$.id')='integer'
    AND json_extract(object.member,'$.id')>0 AND booking.source='employee'
    AND json_type(object.member,'$.createdAt')='text'
    AND booking.created_at=json_extract(object.member,'$.createdAt')
), valid_manual_sources AS (
  SELECT source_key FROM manual_members GROUP BY source_key
  HAVING COUNT(*)=json_array_length(payload,'$.bookings') AND COUNT(DISTINCT booking_id)=COUNT(*)
), call_sources AS (
  SELECT link.call_id FROM call_booking_links link JOIN bookings booking ON booking.id=link.booking_id
  GROUP BY link.call_id HAVING COUNT(*)>=2
    AND SUM(CASE WHEN booking.source='android' THEN 1 ELSE 0 END)=COUNT(*)
    AND COUNT(*)=(SELECT COUNT(*) FROM call_booking_links all_links WHERE all_links.call_id=link.call_id)
), members AS (
  SELECT member.source_key,member.booking_id,member.member_order
  FROM manual_members member JOIN valid_manual_sources valid ON valid.source_key=member.source_key
  UNION ALL
  SELECT 'call:'||link.call_id,link.booking_id,
    ROW_NUMBER() OVER(PARTITION BY link.call_id ORDER BY link.booking_id)-1
  FROM call_booking_links link JOIN call_sources valid ON valid.call_id=link.call_id
), membership_counts AS (
  SELECT booking_id,COUNT(DISTINCT source_key) AS sources FROM members GROUP BY booking_id
), valid_sources AS (
  SELECT member.source_key FROM members member JOIN membership_counts count ON count.booking_id=member.booking_id
  GROUP BY member.source_key HAVING COUNT(DISTINCT member.booking_id)>=2 AND MAX(count.sources)=1
), tokens AS MATERIALIZED (
  SELECT source_key,lower(hex(randomblob(16))) AS group_id FROM valid_sources
), final_members AS (
  SELECT member.booking_id,token.group_id,
    ROW_NUMBER() OVER(PARTITION BY member.source_key ORDER BY member.member_order,member.booking_id)-1 AS member_order
  FROM members member JOIN tokens token ON token.source_key=member.source_key
)
UPDATE bookings SET
  travel_group_id=(SELECT group_id FROM final_members member WHERE member.booking_id=bookings.id),
  travel_group_order=(SELECT member_order FROM final_members member WHERE member.booking_id=bookings.id)
WHERE id IN (SELECT booking_id FROM final_members);
