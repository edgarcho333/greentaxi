import { CarFront, Package } from 'lucide-react';
import { useEffect, useState } from 'react';
import { request, type BookingType, type Direction, type TripCapacity } from '../../api';

export type BookingTypeValue = { bookingType: BookingType; assignedVehicleKey: string };
export function BookingTypeFields({ value, onChange, direction, date, time, bookingId, disabled = false, lockType = false, inline = false }: {
  value: BookingTypeValue; onChange: (value: BookingTypeValue) => void; direction: Direction; date: string; time: string; bookingId?: number; disabled?: boolean; lockType?: boolean; inline?: boolean;
}) {
  const context = `${direction}:${date}:${time}`;
  const [result, setResult] = useState<{ context: string; cars: TripCapacity['drivers']; error: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (value.bookingType !== 'whole_car' || direction !== 'gori-tbilisi' || !date || !time) return;
    const controller = new AbortController();
    request<TripCapacity>(`/admin/trips/capacity?${new URLSearchParams({ direction, date, time })}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ context, cars: data.drivers.filter(car => car.active || car.reservedBookingId === bookingId), error: '' }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ context, cars: [], error: error instanceof Error ? error.message : 'მანქანები ვერ ჩაიტვირთა.' }); });
    return () => controller.abort();
  }, [value.bookingType, direction, date, time, context, revision, bookingId]);
  const current = result?.context === context ? result : null;
  return <div className={inline ? "operator-booking-type-controls" : "admin-form-grid"}>
    {inline ? <>
      <button type="button" disabled={disabled || lockType} aria-pressed={value.bookingType === 'parcel'} onClick={() => onChange({ bookingType: value.bookingType === 'parcel' ? 'passenger' : 'parcel', assignedVehicleKey: '' })}><Package size={21} />გზავნილი</button>
      <button type="button" disabled={disabled || lockType} aria-pressed={value.bookingType === 'whole_car'} onClick={() => onChange({ bookingType: value.bookingType === 'whole_car' ? 'passenger' : 'whole_car', assignedVehicleKey: '' })}><CarFront size={21} />მთლიანი მანქანა</button>
    </> : <label>ჯავშნის ტიპი<select aria-label="ჯავშნის ტიპი" disabled={disabled || lockType} value={value.bookingType} onChange={event => onChange({ bookingType: event.target.value as BookingType, assignedVehicleKey: '' })}>
      <option value="passenger">მგზავრი</option><option value="parcel">გზავნილი</option><option value="whole_car">მთლიანი მანქანა</option>
    </select></label>}
    {value.bookingType === 'parcel' && <p className="admin-form-hint">გზავნილი — სამგზავრო ადგილების გარეშე</p>}
    {value.bookingType === 'whole_car' && <label>დანიშნული მანქანა<select aria-label="დანიშნული მანქანა" required disabled={disabled || !current || !!current.error} value={value.assignedVehicleKey} onChange={event => onChange({ ...value, assignedVehicleKey: event.target.value })}>
      <option value="">აირჩიეთ მანქანა</option>{current?.cars.map(car => <option key={car.key} value={car.key} disabled={!!car.reservedBookingId && car.reservedBookingId !== bookingId}>{car.name} · {car.capacity} ადგილი{!car.active ? ' · დრო გამორთულია' : ''}{car.reservedBookingId && car.reservedBookingId !== bookingId ? ' · დაჯავშნილია' : ''}</option>)}
    </select><small>{direction !== 'gori-tbilisi' ? 'ამ მიმართულებაზე დანიშნული მანქანების სია არ არის.' : !time ? 'ჯერ აირჩიეთ მგზავრობის დრო.' : current?.error || (current?.cars.length === 0 ? 'ამ რეისზე მანქანა არ არის დანიშნული.' : 'მანქანა მთლიანად იჯავშნება.')}</small>{current?.error && <button type="button" disabled={disabled} onClick={() => { setResult(null); setRevision(value => value + 1); }}>ხელახლა ცდა</button>}</label>}
  </div>;
}
export function BookingTypeSummary({ bookingType, assignedVehicleName }: { bookingType?: BookingType; assignedVehicleName?: string | null }) {
  return bookingType === 'parcel' ? <span>გზავნილი</span> : bookingType === 'whole_car' ? <span>მთლიანი მანქანა · {assignedVehicleName}</span> : null;
}
