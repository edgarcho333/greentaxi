import { useCallback, useEffect, useState } from 'react';
import { request, type PassengerProfile } from '../../api';
import { normalizePhone } from '../../../shared/phone';

export function canonicalPassengerPhone(value: string): string | null {
  return normalizePhone(value);
}

type Lookup = { phone: string | null; status: 'idle' | 'loading' | 'found' | 'missing' | 'error'; profile: PassengerProfile | null; error: string };
const idle: Lookup = { phone: null, status: 'idle', profile: null, error: '' };

export default function usePassengerProfile(phone: string, enabled: boolean) {
  const canonicalPhone = canonicalPassengerPhone(phone);
  const [lookup, setLookup] = useState<Lookup>(idle);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled || !canonicalPhone) { setLookup(idle); return; }
    let active = true;
    const controller = new AbortController();
    setLookup({ phone: canonicalPhone, status: 'loading', profile: null, error: '' });
    const timer = window.setTimeout(() => {
      request<{ profile: PassengerProfile | null }>(`/admin/passengers/profile?${new URLSearchParams({ phone: canonicalPhone })}`, { signal: controller.signal })
        .then(({ profile }) => {
          if (!active || controller.signal.aborted) return;
          const exact = profile && canonicalPassengerPhone(profile.phone) === canonicalPhone ? profile : null;
          setLookup({ phone: canonicalPhone, status: exact ? 'found' : 'missing', profile: exact, error: '' });
        })
        .catch(cause => {
          if (!active || controller.signal.aborted) return;
          setLookup({ phone: canonicalPhone, status: 'error', profile: null, error: cause instanceof Error ? cause.message : 'მგზავრის მონაცემების მოძიება ვერ მოხერხდა.' });
        });
    }, 350);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [canonicalPhone, enabled, revision]);

  const current = enabled && canonicalPhone && lookup.phone === canonicalPhone ? lookup : idle;
  return { ...current, canonicalPhone, retry };
}
