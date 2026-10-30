import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CarFront, Check, CheckCircle2, Edit3, LoaderCircle, Phone, Plus, RefreshCw, Save, Trash2, UsersRound, X } from 'lucide-react';
import { ApiError, request, type Direction, type DriverDay, type DriverSchedule } from '../../api';
import { formatPhone, normalizePhone } from '../../../shared/phone';
import './driver-roster.css';

type Feedback = { kind: 'success' | 'error'; message: string } | null;
type DriverChange = { declined: boolean };
type DriverRecord = { id: number; name: string; capacity: number; phone: string | null; revision: number };
type DriverEditor = { kind: 'create' } | { kind: 'edit' | 'delete'; driver: DriverDay; initialPhone: string };
type Props = {
  direction: Direction;
  date: string;
  refreshKey: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChange: () => void;
};

const dateLabel = (date: string) => date.split('-').reverse().join('/');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'ცვლილება ვერ შეინახა. სცადეთ ხელახლა.';

export default function DriverRoster({ direction, date, refreshKey, disabled, onBusyChange, onChange }: Props) {
  const [schedule, setSchedule] = useState<DriverSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [phoneBusyId, setPhoneBusyId] = useState<number | null>(null);
  const [editor, setEditor] = useState<DriverEditor | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [managementFeedback, setManagementFeedback] = useState('');
  const [phoneDrafts, setPhoneDrafts] = useState<Record<number, string>>({});
  const [phoneFeedback, setPhoneFeedback] = useState<Record<number, Feedback>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [retry, setRetry] = useState(0);
  const selectionKey = `${direction}/${date}`;
  const selection = useRef(selectionKey);
  selection.current = selectionKey;
  const sequence = useRef(0);
  const mutation = useRef(false);
  const phoneChanges = useRef(new Map<number, { revision: number; phone: string | null; driverRevision?: number }>());
  const phoneRevision = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const currentSequence = ++sequence.current;
    const readPhoneRevision = phoneRevision.current;
    const controller = new AbortController();
    let active = true;
    setSchedule(null);
    setFeedback(null);
    if (direction !== 'gori-tbilisi') {
      setLoading(false);
      return () => { active = false; controller.abort(); };
    }
    setLoading(true);
    request<DriverSchedule>(`/admin/drivers/schedule?direction=${direction}&date=${date}`, { signal: controller.signal })
      .then(result => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey) {
          // Phone edits are global. Retain a save completed after this day's read started.
          setSchedule({ ...result, drivers: result.drivers.map(driver => {
            const change = phoneChanges.current.get(driver.id);
            return change && change.revision > readPhoneRevision ? { ...driver, phone: change.phone, revision: change.driverRevision ?? driver.revision } : driver;
          }) });
        }
      })
      .catch(error => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey && !controller.signal.aborted) {
          setFeedback({ kind: 'error', message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey) setLoading(false);
      });
    return () => { active = false; controller.abort(); };
  }, [direction, date, refreshKey, retry, selectionKey]);

  async function changeDriver(driver: DriverDay, change: DriverChange) {
    if (mutation.current || disabled || direction !== 'gori-tbilisi' || !schedule || schedule.date !== date) return;
    mutation.current = true;
    const operationKey = selectionKey;
    setBusyId(driver.id);
    setFeedback(null);
    onBusyChange(true);
    try {
      const result = await request<DriverSchedule>(`/admin/drivers/${driver.id}/day`, {
        method: 'PATCH', body: JSON.stringify({ direction, date, ...change }),
      });
      if (mounted.current && selection.current === operationKey) {
        // A mutation returns the complete recalculated day. Do not let an older read replace it.
        sequence.current++;
        setSchedule(result);
        setLoading(false);
        setFeedback({ kind: 'success', message: 'ამ დღის ცვლილება შენახულია.' });
        onChange();
      }
    } catch (error) {
      if (mounted.current && selection.current === operationKey) setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusyId(null);
        onBusyChange(false);
      }
    }
  }

  async function savePhone(driver: DriverDay) {
    if (mutation.current || disabled) return;
    const draft = phoneDrafts[driver.id] ?? driver.phone ?? '';
    const phone = draft.trim() ? normalizePhone(draft) : null;
    if (draft.trim() && (!phone || !/^5\d{8}$/.test(phone))) {
      setPhoneFeedback(current => ({ ...current, [driver.id]: { kind: 'error', message: 'შეიყვანეთ მობილურის სწორი ნომერი, მაგალითად: 599 12 34 56. ნომრის წასაშლელად გაასუფთავეთ ველი.' } }));
      return;
    }
    if (phone === (driver.phone ?? null)) return;
    mutation.current = true;
    setPhoneBusyId(driver.id);
    setPhoneFeedback(current => ({ ...current, [driver.id]: null }));
    onBusyChange(true);
    try {
      const result = await request<{ driverId: number; phone: string | null; revision?: number }>(`/admin/drivers/${driver.id}/phone`, {
        method: 'PATCH', body: JSON.stringify({ phone }),
      });
      if (mounted.current) {
        phoneChanges.current.set(driver.id, { revision: ++phoneRevision.current, phone: result.phone, driverRevision: result.revision });
        setSchedule(current => current && ({ ...current, drivers: current.drivers.map(item => item.id === driver.id ? { ...item, phone: result.phone, revision: result.revision ?? item.revision } : item) }));
        setPhoneDrafts(current => { const next = { ...current }; delete next[driver.id]; return next; });
        setPhoneFeedback(current => ({ ...current, [driver.id]: { kind: 'success', message: result.phone ? 'ტელეფონის ნომერი შენახულია.' : 'ტელეფონის ნომერი წაშლილია. ამ მძღოლისთვის შესვლა გამორთულია.' } }));
        onChange();
      }
    } catch (error) {
      if (mounted.current) setPhoneFeedback(current => ({ ...current, [driver.id]: { kind: 'error', message: error instanceof ApiError && error.code === 'PHONE_TAKEN' ? 'ეს ტელეფონის ნომერი უკვე სხვა მძღოლს ეკუთვნის.' : errorMessage(error) } }));
    } finally {
      mutation.current = false;
      if (mounted.current) { setPhoneBusyId(null); onBusyChange(false); }
    }
  }

  const visibleSchedule = schedule?.direction === direction && schedule.date === date ? schedule : null;
  const firstDriver = visibleSchedule?.drivers.find(driver => driver.id === visibleSchedule.firstDriverId);
  const available = visibleSchedule?.drivers.filter(driver => !driver.declined) ?? [];
  const declinedCount = (visibleSchedule?.drivers.length ?? 0) - available.length;
  const saving = busyId !== null || phoneBusyId !== null || editorBusy;
  const FeedbackIcon = feedback?.kind === 'error' ? AlertCircle : CheckCircle2;

  function openEditor(kind: DriverEditor['kind'], driver?: DriverDay) {
    if (mutation.current || disabled) return;
    setManagementFeedback('');
    setEditor(kind === 'create' ? { kind } : { kind, driver: driver!, initialPhone: phoneDrafts[driver!.id] ?? formatPhone(driver!.phone ?? '') });
  }
  function editorComplete(kind: DriverEditor['kind'], result?: DriverRecord, deletedId?: number) {
    sequence.current++;
    const id = result?.id ?? deletedId;
    if (id !== undefined) {
      setPhoneDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setPhoneFeedback(current => { const next = { ...current }; delete next[id]; return next; });
      if (result) phoneChanges.current.set(id, { revision: ++phoneRevision.current, phone: result.phone, driverRevision: result.revision });
      else phoneChanges.current.delete(id);
    }
    setEditor(null);
    setManagementFeedback(kind === 'create' ? 'მძღოლი დამატებულია.' : kind === 'delete' ? 'მძღოლი სიიდან წაშლილია.' : 'მძღოლის მონაცემები შენახულია.');
    setRetry(value => value + 1);
    onChange();
  }

  return <section className="admin-driver-roster" aria-label="მძღოლების რიგი" data-date={visibleSchedule?.date ?? ''}>
    <div className="admin-driver-heading">
      <div className="admin-driver-heading-icon"><CarFront size={23} /></div>
      <div><h3>მძღოლების რიგი</h3><p>გორი → თბილისი · {dateLabel(date)}</p></div>
      {direction === 'gori-tbilisi' && <button type="button" className="admin-driver-refresh" aria-label="მძღოლების რიგის განახლება" onClick={() => setRetry(value => value + 1)} disabled={loading || saving || disabled}><RefreshCw size={17} /></button>}
    </div>
    {direction !== 'gori-tbilisi' ? <div className="admin-driver-direction-note"><CarFront size={19} /><p>მძღოლების რიგი ამ ეტაპზე მოქმედებს მხოლოდ გორი → თბილისი მიმართულებაზე.</p></div> : <>
      {feedback && <div className={`admin-driver-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}><FeedbackIcon size={17} /><span>{feedback.message}</span>{feedback.kind === 'error' && !visibleSchedule && <button type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}>ხელახლა ცდა</button>}</div>}
      {loading ? <div className="admin-driver-loading" role="status"><LoaderCircle className="admin-config-spinner" size={18} />მძღოლების რიგი იტვირთება…</div> : visibleSchedule ? <>
        <div className="admin-driver-cycle-info">
          <div><span>დღის რიგი იწყება</span><strong>{firstDriver?.name ?? '—'}</strong></div>
          <div className="admin-driver-counts"><span><UsersRound size={15} />{available.length} მონაწილეობს</span><span>{declinedCount} არ მონაწილეობს</span></div>
        </div>
        <p className="admin-driver-explanation">აქ ნახავთ დღის რიგს და მონიშნავთ მონაწილეობას. გასვლის დროს მძღოლს შეკვეთების გვერდზე ხელით მიაბამთ. რიგი ყოველდღე ერთი მძღოლით ინაცვლებს.</p>
        <p className="admin-driver-phone-note" id="admin-driver-phone-help"><Phone size={20} /><span>ტელეფონის ნომრით მძღოლი საკუთარ გვერდზე შედის. ნომრის წასაშლელად გაასუფთავეთ ველი და შეინახეთ.</span></p>
        {managementFeedback && <div className="admin-driver-feedback success" role="status"><CheckCircle2 size={21} /><span>{managementFeedback}</span></div>}
        <div className="admin-driver-management-toolbar"><button type="button" className="admin-driver-add" data-driver-add disabled={saving || disabled} onClick={() => openEditor('create')}><Plus size={25} />მძღოლის დამატება</button></div>
        <div className="admin-driver-table-wrap"><table className="admin-driver-table" aria-label="მძღოლები არჩეულ დღეს">
          <thead><tr><th>რიგი</th><th>მძღოლი</th><th>ტევადობა</th><th>ამ დღის მონაწილეობა</th></tr></thead>
          <tbody>{visibleSchedule.drivers.map(driver => {
            const phone = phoneDrafts[driver.id] ?? formatPhone(driver.phone ?? '');
            const normalized = phone.trim() ? normalizePhone(phone) : null;
            const phoneChanged = normalized !== (driver.phone ?? null) || (!!phone.trim() && (!normalized || !/^5\d{8}$/.test(normalized)));
            const rowFeedback = phoneFeedback[driver.id];
            return <tr key={driver.id} data-driver-id={driver.id} className={driver.declined ? 'declined' : ''}>
              <td className="admin-driver-position"><span>{driver.queuePosition}</span></td>
              <td className="admin-driver-name"><strong>{driver.name}</strong>{driver.id === visibleSchedule.firstDriverId && <small>დღის რიგის დასაწყისი</small>}<div className="admin-driver-phone-editor">
                <label htmlFor={`admin-driver-phone-${driver.id}`}>ტელეფონის ნომერი</label>
                <div className="admin-driver-phone-controls"><input id={`admin-driver-phone-${driver.id}`} aria-label={`${driver.name} — ტელეფონის ნომერი`} aria-describedby={`admin-driver-phone-help${rowFeedback ? ` admin-driver-phone-feedback-${driver.id}` : ''}`} aria-invalid={rowFeedback?.kind === 'error' ? true : undefined} type="tel" inputMode="tel" autoComplete="off" value={phone} placeholder="599 12 34 56" maxLength={32} disabled={saving || disabled} onChange={event => { const value = event.target.value; setPhoneDrafts(current => ({ ...current, [driver.id]: value })); setPhoneFeedback(current => ({ ...current, [driver.id]: null })); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void savePhone(driver); } }} /><button type="button" className="admin-driver-phone-save" aria-label={`${driver.name} — ტელეფონის შენახვა`} disabled={saving || disabled || !phoneChanged} onClick={() => void savePhone(driver)}>{phoneBusyId === driver.id ? <LoaderCircle size={21} className="admin-config-spinner" /> : <Save size={21} />}<span>შენახვა</span></button></div>
                {rowFeedback && <p id={`admin-driver-phone-feedback-${driver.id}`} className={`admin-driver-phone-feedback ${rowFeedback.kind}`} data-driver-phone-feedback role={rowFeedback.kind === 'error' ? 'alert' : 'status'}>{rowFeedback.message}</p>}
              </div><div className="admin-driver-row-actions"><button type="button" className="admin-driver-edit" aria-label={`${driver.name} — რედაქტირება`} disabled={saving || disabled} onClick={() => openEditor('edit', driver)}><Edit3 size={21} /><span>რედაქტირება</span></button><button type="button" className="admin-driver-delete" aria-label={`${driver.name} — წაშლა`} disabled={saving || disabled} onClick={() => openEditor('delete', driver)}><Trash2 size={21} /><span>წაშლა</span></button></div></td>
              <td className="admin-driver-capacity"><span><UsersRound size={14} />{driver.capacity} ადგილი</span></td>
              <td className="admin-driver-participation"><button type="button" role="switch" aria-checked={!driver.declined} aria-label={`${driver.name} — მონაწილეობა ამ დღეს`} className={`admin-driver-attendance ${driver.declined ? 'declined' : ''}`} onClick={() => changeDriver(driver, { declined: !driver.declined })} disabled={saving || disabled}>
                {busyId === driver.id ? <LoaderCircle className="admin-config-spinner" size={16} /> : driver.declined ? <X size={16} /> : <Check size={16} />}<span>{driver.declined ? 'არ მონაწილეობს' : 'მონაწილეობს'}</span>
              </button></td>
            </tr>;
          })}</tbody>
        </table></div>
        {visibleSchedule.drivers.length === 0 && <div className="admin-driver-empty-times">მძღოლები ჯერ არ არის დამატებული.</div>}
        <p className="admin-driver-footnote">ამ დღის მონაწილეობის შეცვლა შემდეგი დღის რიგს არ ცვლის.</p>
      </> : null}
    </>}
    {editor && <DriverEditorDialog key={editor.kind === 'create' ? 'create' : `${editor.kind}-${editor.driver.id}`} editor={editor} freshDriver={editor.kind === 'create' ? undefined : visibleSchedule?.drivers.find(driver => driver.id === editor.driver.id)} onClose={() => setEditor(null)} onBusy={value => { mutation.current = value; setEditorBusy(value); onBusyChange(value); }} onConflict={() => setRetry(value => value + 1)} onComplete={editorComplete} />}
  </section>;
}

type DriverAttempt = { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body: string; key: string; ambiguous: boolean };

function DriverEditorDialog({ editor, freshDriver, onClose, onBusy, onConflict, onComplete }: {
  editor: DriverEditor;
  freshDriver?: DriverDay;
  onClose: () => void;
  onBusy: (value: boolean) => void;
  onConflict: () => void;
  onComplete: (kind: DriverEditor['kind'], result?: DriverRecord, deletedId?: number) => void;
}) {
  const id = useId();
  const original = editor.kind === 'create' ? null : editor.driver;
  const [base, setBase] = useState(original);
  const [name, setName] = useState(original?.name ?? '');
  const [phone, setPhone] = useState(editor.kind === 'create' ? '' : editor.initialPhone);
  const [capacity, setCapacity] = useState(original?.capacity ?? 7);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<DriverAttempt | null>(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const busyRef = useRef(false);
  const attemptRef = useRef<DriverAttempt | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const locked = busy || attempt !== null;
  const title = editor.kind === 'create' ? 'მძღოლის დამატება' : editor.kind === 'edit' ? 'მძღოლის რედაქტირება' : 'მძღოლის წაშლა';
  const submitLabel = editor.kind === 'create' ? 'მძღოლის დამატება' : editor.kind === 'edit' ? 'შენახვა' : 'მძღოლის წაშლა';

  useEffect(() => {
    active.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (editor.kind === 'delete' ? cancel.current : firstInput.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current && !attemptRef.current) closeRef.current();
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
      if (!controls.length) { event.preventDefault(); dialog.current.focus(); return; }
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      active.current = false;
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      window.requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
        else document.querySelector<HTMLButtonElement>('[data-driver-add]')?.focus();
      });
    };
  }, [editor.kind]);

  function close() { if (!busyRef.current && !attemptRef.current) onClose(); }
  function reloadCurrent() {
    if (locked || !freshDriver) return;
    setBase(freshDriver); setName(freshDriver.name); setPhone(formatPhone(freshDriver.phone ?? '')); setCapacity(freshDriver.capacity);
    setConflict(false); setError(''); firstInput.current?.focus();
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (busyRef.current) return;
    let next = attemptRef.current;
    if (!next) {
      if (conflict) return;
      const normalized = phone.trim() ? normalizePhone(phone) : null;
      if (editor.kind !== 'delete') {
        if (!name.trim() || name.trim().length > 100) { setError('მიუთითეთ მძღოლის სახელი.'); firstInput.current?.focus(); return; }
        if (phone.trim() && (!normalized || !/^5\d{8}$/.test(normalized))) { setError('შეიყვანეთ მობილურის სწორი ნომერი, მაგალითად: 599 12 34 56.'); return; }
      }
      const body = editor.kind === 'delete' ? { expectedRevision: base!.revision ?? 1 }
        : { name: name.trim(), capacity, phone: normalized, ...(base ? { expectedRevision: base.revision ?? 1 } : {}) };
      next = { path: editor.kind === 'create' ? '/admin/drivers' : `/admin/drivers/${base!.id}`, method: editor.kind === 'create' ? 'POST' : editor.kind === 'edit' ? 'PATCH' : 'DELETE', body: JSON.stringify(body), key: crypto.randomUUID(), ambiguous: false };
      attemptRef.current = next; setAttempt(next);
    }
    busyRef.current = true; setBusy(true); setError(''); onBusy(true);
    try {
      const result = await request<{ driver?: DriverRecord }>(next.path, { method: next.method, body: next.body, headers: { 'Idempotency-Key': next.key } });
      if (editor.kind !== 'delete' && !result.driver) throw new Error('ცვლილების პასუხი ვერ შემოწმდა. გაიმეორეთ გაგზავნა.');
      if (!active.current) return;
      attemptRef.current = null; setAttempt(null);
      onComplete(editor.kind, result.driver, editor.kind === 'delete' ? base!.id : undefined);
    } catch (cause) {
      if (!active.current) return;
      const rejected = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const needsLogin = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (rejected && !(next.ambiguous && needsLogin)) {
        attemptRef.current = null; setAttempt(null); setError(errorMessage(cause));
        if (cause.code === 'DRIVER_CHANGED' || cause.code === 'NOT_FOUND') { setConflict(true); onConflict(); }
      } else {
        const pending = { ...next, ambiguous: true };
        attemptRef.current = pending; setAttempt(pending);
        setError(needsLogin ? 'სხვა ჩანართში იმავე ანგარიშით შედით ხელახლა და აქ გაიმეორეთ გაგზავნა.' : errorMessage(cause));
      }
    } finally {
      busyRef.current = false; onBusy(false); if (active.current) setBusy(false);
    }
  }

  return createPortal(<div className="admin-modal-overlay admin-driver-editor-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section ref={dialog} className="admin-dialog admin-driver-editor-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy} tabIndex={-1} data-driver-editor={editor.kind}>
    <header><div><h2 id={`${id}-title`}>{title}</h2><p id={`${id}-description`}>{editor.kind === 'delete' ? 'მძღოლი რიგიდან გაქრება და მის ანგარიშში შესვლა შეწყდება. არსებული ჯავშნები და ისტორია დარჩება.' : editor.kind === 'create' ? 'ახალი მძღოლი რიგის ბოლოში დაემატება.' : 'შეცვალეთ მძღოლის სახელი, ტელეფონი და მანქანის ტევადობა.'}</p></div><button type="button" className="admin-icon-button" aria-label="დახურვა" disabled={locked} onClick={close}><X size={25} /></button></header>
    <form className="admin-driver-editor-form" onSubmit={submit} noValidate={attempt !== null}>
      {editor.kind === 'delete' ? <div className="admin-driver-delete-summary"><Trash2 size={32} /><strong>{base?.name}</strong>{base?.phone && <span>{formatPhone(base.phone)}</span>}<p>ნამდვილად გსურთ ამ მძღოლის წაშლა?</p></div> : <>
        <label>მძღოლის სახელი<input ref={firstInput} aria-label="მძღოლის სახელი" autoComplete="off" value={name} required maxLength={100} disabled={locked} onChange={event => { setName(event.target.value); setError(''); }} /></label>
        <label>ტელეფონის ნომერი<input aria-label="ტელეფონის ნომერი" aria-describedby={`${id}-phone-help`} type="tel" inputMode="tel" autoComplete="off" placeholder="599 12 34 56" maxLength={32} value={phone} disabled={locked} onChange={event => { setPhone(event.target.value); setError(''); }} onBlur={() => setPhone(value => formatPhone(value))} /><small id={`${id}-phone-help`}>არასავალდებულო. ამ ნომრით მძღოლი საკუთარ გვერდზე შევა. ცარიელი ველი ტელეფონით შესვლას გამორთავს.</small></label>
        <fieldset className="admin-driver-editor-capacity" role="group" aria-label="მანქანის ტევადობა"><legend>მანქანის ტევადობა</legend><div>{Array.from({ length: 8 }, (_, index) => index + 1).map(seats => <button type="button" key={seats} aria-label={`${seats} ადგილი`} aria-pressed={capacity === seats} disabled={locked} onClick={() => { setCapacity(seats); setError(''); }}>{seats}</button>)}</div><p>{capacity} სამგზავრო ადგილი</p></fieldset>
      </>}
      {error && <div className="admin-driver-editor-feedback error" role="alert" data-driver-editor-error>{error}</div>}
      {conflict && !attempt && <div className="admin-driver-editor-conflict" role="status"><p>მონაცემები შეიცვალა. განახლება მიმდინარე მონაცემებს ჩატვირთავს. შეამოწმეთ და ხელახლა შეინახეთ.</p><button type="button" disabled={busy || !freshDriver || (freshDriver.revision ?? 1) === (base?.revision ?? 1)} onClick={reloadCurrent}><RefreshCw size={22} />მონაცემების განახლება</button></div>}
      {attempt && !busy && <p className="admin-driver-editor-feedback pending" role="status" data-driver-editor-pending>პასუხი ვერ მივიღეთ. განმეორებითი გაგზავნა იმავე ცვლილებას შეამოწმებს.</p>}
      <footer className="admin-dialog-footer"><button ref={cancel} type="button" className="admin-secondary" disabled={locked} onClick={close}>გაუქმება</button><button type="submit" className={editor.kind === 'delete' ? 'admin-danger-button' : 'admin-primary'} disabled={busy || (conflict && !attempt)}>{busy ? <LoaderCircle size={23} className="admin-config-spinner" /> : editor.kind === 'delete' ? <Trash2 size={23} /> : <Save size={23} />}{attempt && !busy ? 'განმეორებით გაგზავნა' : submitLabel}</button></footer>
    </form>
  </section></div>, document.body);
}
