import { CarFront, Package, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { request, type BookingType, type Direction, type WholeCarDriver, type WholeCarOptions } from '../../api';
import WholeCarPickerDialog from './WholeCarPickerDialog';
import './whole-car-picker.css';

export type BookingTypeValue = { bookingType: BookingType; assignedVehicleKey: string; expectedVehicleRevision?: string };
type Result = { context: string; data: WholeCarOptions | null; loading: boolean; error: string };
export function BookingTypeFields({ value, onChange, direction, date, time, bookingId, disabled = false, lockType = false, inline = false }: {
  value: BookingTypeValue; onChange: (value: BookingTypeValue) => void; direction: Direction; date: string; time: string; bookingId?: number; disabled?: boolean; lockType?: boolean; inline?: boolean;
}) {
  const context = `${direction}:${date}:${time}`;
  const selection = useRef(context);
  selection.current = context;
  const [result, setResult] = useState<Result | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [openContext, setOpenContext] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{ context: string; driver: WholeCarDriver } | null>(null);
  const eligible = value.bookingType === 'whole_car' && direction === 'gori-tbilisi' && !!date && !!time;
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    setResult(previous => ({ context, data: previous?.context === context ? previous.data : null, loading: true, error: '' }));
    request<WholeCarOptions>(`/admin/trips/whole-car-options?${new URLSearchParams({ direction, date, time })}`, { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted || selection.current !== context) return;
        if (data.direction !== direction || data.date !== date || data.time !== time) throw new Error('არჩეული რეისის სია ვერ განახლდა. სცადეთ ხელახლა.');
        setResult({ context, data, loading: false, error: '' });
      })
      .catch(error => {
        if (!controller.signal.aborted && selection.current === context) setResult(previous => ({ context, data: previous?.context === context ? previous.data : null, loading: false, error: error instanceof Error ? error.message : 'მძღოლები ვერ ჩაიტვირთა.' }));
      });
    return () => controller.abort();
  }, [eligible, direction, date, time, context, refresh]);
  const current = result?.context === context ? result : null;
  const selected = current?.data?.drivers.find(driver => driver.key === value.assignedVehicleKey) ?? (chosen?.context === context && chosen.driver.key === value.assignedVehicleKey ? chosen.driver : null);
  useEffect(() => {
    // Retaining a stored same-hour car does not introduce a new assignment.
    // Keep an explicit selection's revision unchanged after a conflict or refresh.
    if (!eligible || !current?.data || current.loading || current.error || value.expectedVehicleRevision || !value.assignedVehicleKey) return;
    const existing = current.data.drivers.find(driver => driver.key === value.assignedVehicleKey);
    if (!existing || existing.declined || existing.assignedTime !== time || existing.reservedBookingId && existing.reservedBookingId !== bookingId) return;
    onChange({ ...value, expectedVehicleRevision: existing.revision });
  }, [eligible, current?.data, current?.loading, current?.error, value.assignedVehicleKey, value.expectedVehicleRevision, context, time, bookingId, onChange]);
  const open = openContext === context && eligible;
  const needsConfirmation = !!selected && (selected.declined || selected.assignedTime !== time) && !value.expectedVehicleRevision;
  function retry() {
    setResult(previous => ({ context, data: previous?.context === context ? previous.data : null, loading: true, error: '' }));
    setRefresh(value => value + 1);
  }
  function selectDriver(driver: WholeCarDriver) {
    if (disabled || current?.loading || current?.error || selection.current !== context) return;
    setChosen({ context, driver });
    onChange({ ...value, assignedVehicleKey: driver.key, expectedVehicleRevision: driver.revision });
    setOpenContext(null);
  }
  function toggleType(bookingType: BookingType) {
    setOpenContext(null);
    onChange({ bookingType, assignedVehicleKey: '', expectedVehicleRevision: undefined });
  }
  const hint = direction !== 'gori-tbilisi' ? 'ამ მიმართულებაზე მანქანების სია არ არის.' : !date || !time ? 'ჯერ აირჩიეთ მგზავრობის დრო.' : needsConfirmation ? 'დაადასტურეთ მძღოლის არჩევანი.' : selected ? 'მანქანა მთლიანად დაიჯავშნება ჯავშნის შენახვისას.' : 'აირჩიეთ მძღოლი დღის რიგიდან.';
  return <div className={inline ? 'operator-booking-type-controls' : 'admin-form-grid'}>
    {inline ? <>
      <button type="button" disabled={disabled || lockType} aria-pressed={value.bookingType === 'parcel'} onClick={() => toggleType(value.bookingType === 'parcel' ? 'passenger' : 'parcel')}><Package size={21} />გზავნილი</button>
      <button type="button" disabled={disabled || lockType} aria-pressed={value.bookingType === 'whole_car'} onClick={() => toggleType(value.bookingType === 'whole_car' ? 'passenger' : 'whole_car')}><CarFront size={21} />მთლიანი მანქანა</button>
    </> : <label>ჯავშნის ტიპი<select aria-label="ჯავშნის ტიპი" disabled={disabled || lockType} value={value.bookingType} onChange={event => toggleType(event.target.value as BookingType)}><option value="passenger">მგზავრი</option><option value="parcel">გზავნილი</option><option value="whole_car">მთლიანი მანქანა</option></select></label>}
    {value.bookingType === 'parcel' && <p className="admin-form-hint">გზავნილი — სამგზავრო ადგილების გარეშე</p>}
    {value.bookingType === 'whole_car' && <div className="whole-car-selection" role="group" aria-label="მთლიანი მანქანის მძღოლი">
      <span className="whole-car-selection-label">დანიშნული მანქანა</span>
      <button type="button" className="whole-car-selection-trigger" data-whole-car-picker aria-label="დანიშნული მანქანა" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !eligible} onClick={() => { retry(); setOpenContext(context); }}><CarFront size={26} /><span>{selected ? <><strong data-whole-car-selected-name>{selected.name}</strong><span>{selected.capacity} ადგილი · {needsConfirmation ? 'არჩევის დადასტურება' : 'შეცვლა'}</span></> : <strong>აირჩიეთ მძღოლი</strong>}</span></button>
      <small className={needsConfirmation ? 'whole-car-confirmation-needed' : undefined}>{hint}</small>
      {current?.error && !open && <div className="whole-car-selection-error" role="alert"><span>{current.error}</span><button type="button" onClick={retry} disabled={disabled || current.loading}><RefreshCw size={18} />ხელახლა ცდა</button></div>}
    </div>}
    {open && <WholeCarPickerDialog key={context} direction={direction} date={date} time={time} drivers={current?.data?.drivers ?? []} selectedKey={value.assignedVehicleKey} bookingId={bookingId} active={current?.data?.active ?? false} loading={!current || current.loading} error={current?.error ?? ''} disabled={disabled} onSelect={selectDriver} onClose={() => setOpenContext(null)} onRetry={retry} />}
  </div>;
}
export function BookingTypeSummary({ bookingType, assignedVehicleName }: { bookingType?: BookingType; assignedVehicleName?: string | null }) {
  return bookingType === 'parcel' ? <span>გზავნილი</span> : bookingType === 'whole_car' ? <span>მთლიანი მანქანა · {assignedVehicleName}</span> : null;
}
