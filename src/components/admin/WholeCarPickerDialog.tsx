import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowRightLeft, CarFront, Check, Clock3, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { directions, type Direction, type WholeCarDriver } from '../../api';
import './trip-capacity.css';
import './whole-car-picker.css';

type Props = {
  direction: Direction; date: string; time: string; drivers: WholeCarDriver[];
  selectedKey: string; bookingId?: number; active: boolean; loading: boolean; error: string; disabled: boolean;
  onSelect: (driver: WholeCarDriver) => void; onClose: () => void; onRetry: () => void;
};

export default function WholeCarPickerDialog({ direction, date, time, drivers, selectedKey, bookingId, active, loading, error, disabled, onSelect, onClose, onRetry }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [transferKey, setTransferKey] = useState('');
  const available = drivers;
  const candidate = available.find(driver => driver.key === transferKey);
  const needsTransfer = !!candidate?.assignedTime && candidate.assignedTime !== time;
  const confirmation = candidate && (candidate.declined || needsTransfer) ? candidate : null;
  const blocked = (driver: WholeCarDriver) => !!driver.reservedBookingId && driver.reservedBookingId !== bookingId;
  const slotAllowed = (driver: WholeCarDriver) => active || bookingId !== undefined && driver.key === selectedKey && driver.assignedTime === time;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
    const frame = window.requestAnimationFrame(() => {
      (dialog.current?.querySelector<HTMLElement>('[data-whole-car-driver]:not(:disabled)') ?? focusable()[0] ?? dialog.current)?.focus();
    });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // A picker can sit above the booking form. Escape closes this layer only.
        event.preventDefault(); event.stopImmediatePropagation(); close.current();
      } else if (event.key === 'Tab') {
        const choices = focusable();
        const first = choices[0]; const last = choices[choices.length - 1];
        if (!first) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const next = transferKey ? dialog.current?.querySelector<HTMLElement>('[data-whole-car-confirm]') : dialog.current?.querySelector<HTMLElement>('[data-whole-car-driver]:not(:disabled)');
      next?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [transferKey, loading]);

  function choose(driver: WholeCarDriver) {
    if (disabled || loading || blocked(driver) || !slotAllowed(driver)) return;
    if (driver.declined || driver.assignedTime && driver.assignedTime !== time) setTransferKey(driver.key);
    else onSelect(driver);
  }

  return createPortal(<div className="admin-driver-dialog-backdrop whole-car-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="admin-driver-dialog whole-car-picker-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={loading} tabIndex={-1} data-whole-car-dialog data-trip-date={date} data-trip-time={time}>
      <header className="admin-driver-dialog-heading"><div><h2 id={`${id}-title`}>აირჩიეთ მძღოლი</h2><p><strong>{time}</strong> · {date.split('-').reverse().join('/')} · {directions[direction]}</p></div><button type="button" className="admin-driver-dialog-close" aria-label="მანქანის არჩევის დახურვა" onClick={onClose}><X size={25} /></button></header>
      <p className="admin-driver-dialog-description" id={`${id}-description`}>ყველა მძღოლი, დღის რიგით. მთლიანი მანქანა დაიჯავშნება ჯავშნის შენახვისას.</p>
      {loading && <p className="whole-car-picker-status" role="status"><LoaderCircle size={23} className="admin-spin" />მძღოლები იტვირთება…</p>}
      {error && <div className="admin-trip-capacity-feedback error" role="alert"><AlertCircle size={20} /><span>{error}</span><button type="button" className="admin-trip-capacity-button" onClick={onRetry} disabled={loading || disabled}><RefreshCw size={19} />ხელახლა ცდა</button></div>}
      {!active && !loading && !error && <p className="admin-trip-capacity-warning" role="status"><AlertCircle size={19} /><span>ეს დრო გამორთულია. სხვა მძღოლის ასარჩევად ჯერ ჩართეთ დრო პარამეტრებში.</span></p>}
      {confirmation ? <div className="admin-driver-transfer" data-whole-car-transfer={needsTransfer || undefined} data-whole-car-activation={confirmation.declined || undefined}>
        <h3>{confirmation.name}</h3>
        {confirmation.declined && <p>ეს მძღოლი ამ დღეს არ მონაწილეობს. ჯავშნის შენახვისას ამ დღის მონაწილე გახდება და <strong>{time}</strong>-ზე მიებმება.</p>}
        {needsTransfer && <><p>ეს მძღოლი მიბმულია <strong>{confirmation.assignedTime}</strong>-ზე. ჯავშნის შენახვისას იქიდან მოიხსნება და <strong>{time}</strong>-ზე გადმოვა.</p><p className="admin-driver-transfer-times"><Clock3 size={22} /><strong>{confirmation.assignedTime}</strong><ArrowRightLeft size={22} /><strong>{time}</strong></p></>}
        <div className="admin-driver-dialog-buttons"><button type="button" className="admin-trip-capacity-button primary" data-whole-car-confirm data-whole-car-transfer-confirm={needsTransfer || undefined} data-whole-car-activation-confirm={confirmation.declined || undefined} disabled={disabled || loading || !!error || blocked(confirmation) || !slotAllowed(confirmation)} onClick={() => onSelect(confirmation)}><Check size={20} />{confirmation.declined ? needsTransfer ? `ჩართვა და გადაყვანა ${time}-ზე` : 'ჩართვა და არჩევა' : `არჩევა და გადაყვანა ${time}-ზე`}</button><button type="button" className="admin-trip-capacity-button" onClick={() => setTransferKey('')}>უკან</button></div>
      </div> : <div className="admin-driver-choice-grid" role="group" aria-label="მთლიანი მანქანის მძღოლები">{available.map(driver => {
        const reserved = blocked(driver);
        const selected = driver.key === selectedKey;
        const status = reserved ? 'მთლიანად დაჯავშნილია' : driver.reservedBookingId === bookingId && bookingId !== undefined ? 'ამ ჯავშნის მანქანა' : driver.declined ? `ამ დღეს არ მონაწილეობს${driver.assignedTime ? ` · ${driver.assignedTime}-ზეა` : ''}` : driver.assignedTime === time ? 'ამ დროზეა' : driver.assignedTime ? `${driver.assignedTime}-ზეა · გადაყვანა` : 'დროის გარეშე';
        return <button type="button" key={driver.key} className={`admin-driver-choice${selected ? ' selected' : ''}${reserved ? ' reserved' : ''}${driver.declined ? ' declined' : ''}`} data-whole-car-driver={driver.key} data-whole-car-declined={String(driver.declined)} data-whole-car-queue={driver.queuePosition ?? ''} aria-label={`${driver.name} · ${driver.capacity} ადგილი${driver.queuePosition === null ? '' : ` · რიგი ${driver.queuePosition}`} · ${status}`} aria-pressed={selected} disabled={disabled || loading || !!error || reserved || !slotAllowed(driver)} onClick={() => choose(driver)}>
          <span className="admin-driver-choice-position" aria-hidden="true">{driver.queuePosition ?? <CarFront size={24} />}</span><span className="admin-driver-choice-info"><strong>{driver.name}</strong><span>{driver.capacity} ადგილი</span><small>{status}</small></span>{selected ? <Check size={25} /> : <CarFront size={25} />}
        </button>;
      })}</div>}
      {!loading && !error && available.length === 0 && <p className="admin-driver-dialog-empty">მძღოლების სია ცარიელია.</p>}
    </div>
  </div>, document.body);
}
