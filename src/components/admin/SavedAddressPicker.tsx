import type { PassengerProfile } from '../../api';
import './saved-address-picker.css';

const addressKey = (address: string) => address.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function savedGoriAddresses(profile: PassengerProfile | null | undefined, fallback: string[] = []) {
  const addresses = [...(profile?.addresses || []).filter(item => item.city === 'gori').map(item => item.address), profile?.goriPickupAddress || '', profile?.goriAddress || '', ...fallback];
  const seen = new Set<string>();
  return addresses.filter(address => {
    const key = addressKey(address);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(address => address.trim());
}

export default function SavedAddressPicker({ addresses, value, disabled, onChoose, label = 'შენახული მისამართები გორში' }: {
  addresses: string[]; value: string; disabled: boolean; onChoose: (address: string) => void; label?: string;
}) {
  if (!addresses.length) return null;
  const selected = addresses.find(address => addressKey(address) === addressKey(value)) || '';
  return <label className="admin-saved-address-picker"><span>{label}<small>{addresses.length}</small></span><select aria-label={label} value={selected} disabled={disabled} onChange={event => onChoose(event.target.value)}><option value="">ახალი მისამართი / ხელით შეყვანა</option>{addresses.map(address => <option key={addressKey(address)} value={address}>{address}</option>)}</select></label>;
}
