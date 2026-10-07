/** Georgian numbers are stored nationally; foreign numbers retain their country code. */
export function normalizePhone(value: string): string | null {
  const input = value.trim();
  if (!input || !/^\+?[\d\s()-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, '');
  if (digits.startsWith('00') && digits.length >= 11) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith('995')) return digits.slice(3);
  if (digits.length === 9 && !input.startsWith('+')) return digits;
  if (digits.length < 9 || digits.length > 15 || digits.startsWith('0')) return null;
  return `+${digits}`;
}

/** Display the familiar Georgian 3–2–2–2 grouping without losing partially typed input. */
export function formatPhone(value: string): string {
  const normalized = normalizePhone(value);
  if (!normalized) return value;
  if (/^\d{9}$/.test(normalized)) return `${normalized.slice(0, 3)} ${normalized.slice(3, 5)} ${normalized.slice(5, 7)} ${normalized.slice(7)}`;
  return normalized;
}

/** tel: links and legacy event hashes require an international Georgian number. */
export function phoneDialNumber(value: string): string | null {
  const normalized = normalizePhone(value);
  return normalized && /^\d{9}$/.test(normalized) ? `+995${normalized}` : normalized;
}

export function legacyPhoneKey(value: string): string | null {
  return phoneDialNumber(value);
}

/** Old and new storage keys coexist briefly during a rolling deployment. */
export function phoneAliases(value: string): string[] {
  const normalized = normalizePhone(value);
  if (!normalized) return [];
  if (/^\d{9}$/.test(normalized)) return [normalized, `+995${normalized}`, `995${normalized}`, `00995${normalized}`];
  return [normalized];
}
