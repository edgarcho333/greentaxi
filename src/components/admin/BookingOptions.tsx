import { Dog, Luggage } from 'lucide-react';
import './booking-options.css';

export type BookingOptionsValue = {
  luggage: boolean;
  dog: boolean;
  seatPreference: 'front' | 'back' | 'middle' | null;
};

type BookingOptionsProps = {
  value: BookingOptionsValue;
  onChange: (value: BookingOptionsValue) => void;
  disabled?: boolean;
};

const preferences: { value: NonNullable<BookingOptionsValue['seatPreference']>; label: string }[] = [
  { value: 'front', label: 'წინ' },
  { value: 'back', label: 'უკან' },
  { value: 'middle', label: 'შუაში' },
];

export function BookingOptions({ value, onChange, disabled = false }: BookingOptionsProps) {
  return <div className="operator-booking-options">
    <fieldset className="operator-booking-options-group" aria-label="დამატებითი სერვისები">
      <legend>დამატებითი სერვისები</legend>
      <div className="operator-booking-options-services">
        <button type="button" disabled={disabled} aria-pressed={value.luggage} onClick={() => onChange({ ...value, luggage: !value.luggage })}><Luggage size={21} />ბარგი</button>
        <button type="button" disabled={disabled} aria-pressed={value.dog} onClick={() => onChange({ ...value, dog: !value.dog })}><Dog size={21} />ძაღლი</button>
      </div>
    </fieldset>
    <fieldset className="operator-booking-options-group" aria-label="სასურველი ადგილი">
      <legend>ადგილი</legend>
      <div className="operator-booking-options-preferences">{preferences.map(preference => <button type="button" key={preference.value} disabled={disabled} aria-pressed={value.seatPreference === preference.value} onClick={() => onChange({ ...value, seatPreference: value.seatPreference === preference.value ? null : preference.value })}>{preference.label}</button>)}</div>
    </fieldset>
  </div>;
}

export function BookingOptionsSummary({ luggage = false, dog = false, seatPreference = null }: Partial<BookingOptionsValue>) {
  const preference = preferences.find(item => item.value === seatPreference);
  if (!luggage && !dog && !preference) return null;
  return <div className="operator-booking-options-summary" aria-label="დამატებითი სერვისები და ადგილი">
    {luggage && <span><Luggage size={14} />ბარგი</span>}
    {dog && <span><Dog size={14} />ძაღლი</span>}
    {preference && <span>ადგილი: {preference.label}</span>}
  </div>;
}
