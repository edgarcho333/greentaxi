import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRightLeft, CarFront, Check, ChevronDown, ChevronUp, Clock3, LoaderCircle, Plus, RefreshCw, Settings2, Trash2, UserRound, X } from 'lucide-react';
import { ApiError, request, type Direction, type DriverDay, type TripCapacity as TripCapacityData, type TripDriver, type TripDriverMutation, type TripDriverSelection } from '../../api';
import './trip-capacity.css';

type Props = { direction: Direction; date: string; time: string; refresh: number; onChange: () => void };
type Feedback = { kind: 'success' | 'error'; message: string } | null;
type Editor = { action: 'add' } | { action: 'replace'; removeKey: string; name: string };
const dateLabel = (date: string) => date.split('-').reverse().join('/');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'მონაცემები ვერ განახლდა. სცადეთ ხელახლა.';

function exactTrip(data: TripCapacityData, direction: Direction, date: string, time: string) {
  return data.direction === direction && data.date === date && data.time === time;
}

export default function TripCapacity({ direction, date, time, refresh, onChange }: Props) {
  const selectionKey = `${direction}/${date}/${time}`;
  const selection = useRef(selectionKey);
  selection.current = selectionKey;
  const [record, setRecord] = useState<{ key: string; data: TripCapacityData } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selectionKind, setSelectionKind] = useState<'roster' | 'temporary'>('roster');
  const [driverId, setDriverId] = useState('');
  const [temporaryName, setTemporaryName] = useState('');
  const [temporaryCapacity, setTemporaryCapacity] = useState(7);
  const [writeReady, setWriteReady] = useState(false);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const visibleTrip = record?.key === selectionKey && exactTrip(record.data, direction, date, time) ? record.data : null;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readSequence.current++; readController.current?.abort(); };
  }, []);

  useEffect(() => {
    setRecord(null); setLoading(direction === 'gori-tbilisi' && !!time);
    setReadError(''); setFeedback(null); setWriteReady(false);
    setExpanded(false); setEditor(null); setDriverId(''); setTemporaryName('');
    setTemporaryCapacity(7); setSelectionKind('roster');
  }, [selectionKey, direction, time]);

  const load = useCallback(async () => {
    if (direction !== 'gori-tbilisi' || !time || document.visibilityState === 'hidden' || mutation.current || readController.current) return;
    const controller = new AbortController();
    readController.current = controller;
    const sequence = ++readSequence.current;
    const current = () => mounted.current && selection.current === selectionKey && readSequence.current === sequence && !controller.signal.aborted;
    try {
      const params = new URLSearchParams({ direction, date, time });
      const data = await request<TripCapacityData>(`/admin/trips/capacity?${params}`, { signal: controller.signal });
      if (!current()) return;
      if (!exactTrip(data, direction, date, time)) throw new Error('არჩეული რეისის მონაცემები ვერ განახლდა. სცადეთ ხელახლა.');
      setRecord({ key: selectionKey, data }); setReadError(''); setWriteReady(true);
    } catch (error) {
      if (current()) { setReadError(errorMessage(error)); setWriteReady(false); }
    } finally {
      if (current()) setLoading(false);
      if (readController.current === controller) readController.current = null;
    }
  }, [direction, date, time, selectionKey]);

  useEffect(() => {
    void load();
    const refreshVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(refreshVisible, 5_000);
    window.addEventListener('focus', refreshVisible); document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      readSequence.current++; readController.current?.abort(); readController.current = null;
      window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [load, refresh, retry]);

  async function changeTrip(action: TripDriverMutation['action'], driver?: TripDriverSelection, removeKey?: string) {
    if (mutation.current || !writeReady || !visibleTrip?.active || direction !== 'gori-tbilisi') return;
    mutation.current = true;
    const operationKey = selectionKey;
    readSequence.current++; readController.current?.abort(); readController.current = null;
    setBusy(true); setFeedback(null); setReadError('');
    const payload: TripDriverMutation = { direction, date, time, expectedRevision: visibleTrip.revision, action, ...(removeKey ? { removeKey } : {}), ...(driver ? { driver } : {}) };
    let refreshAfter = false;
    try {
      const data = await request<TripCapacityData>('/admin/trips/drivers', { method: 'POST', body: JSON.stringify(payload) });
      if (mounted.current && selection.current === operationKey) {
        if (!exactTrip(data, direction, date, time)) throw new Error('ცვლილების შედეგი ვერ განახლდა. შეამოწმეთ რეისი.');
        readSequence.current++;
        setRecord({ key: operationKey, data }); setLoading(false); setWriteReady(true);
        setFeedback({ kind: 'success', message: action === 'remove' ? 'მძღოლი ამ რეისიდან მოხსნილია.' : action === 'replace' ? 'რეისის მძღოლი შეცვლილია.' : 'მძღოლი რეისზე დამატებულია.' });
        setEditor(null); setDriverId(''); setTemporaryName('');
      }
      if (mounted.current) onChange();
    } catch (error) {
      refreshAfter = true;
      if (mounted.current && selection.current === operationKey) {
        setWriteReady(false);
        setFeedback({ kind: 'error', message: error instanceof ApiError && (error.code === 'TRIP_CHANGED' || error.status === 409) ? 'რეისი სხვა ოპერატორმა შეცვალა. მონაცემები განახლდება — გადაამოწმეთ არჩევანი და ხელახლა შეინახეთ.' : errorMessage(error) });
      }
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusy(false);
        // Selection can change during a write. Load its own data after the write settles.
        if (refreshAfter || selection.current !== operationKey) setRetry(value => value + 1);
      }
    }
  }

  function openEditor(next: Editor) {
    setEditor(next); setDriverId(''); setSelectionKind('roster'); setTemporaryName(''); setTemporaryCapacity(7); setFeedback(null);
  }

  function candidateAvailable(driver: DriverDay) {
    return !driver.declined && !visibleTrip?.drivers.some(assigned => assigned.driverId === driver.id);
  }

  function saveSelection(event: FormEvent) {
    event.preventDefault();
    if (!editor || !visibleTrip) return;
    let chosen: TripDriverSelection;
    if (selectionKind === 'roster') {
      const candidate = visibleTrip.availableDrivers.find(driver => driver.id === Number(driverId));
      if (!candidate || !candidateAvailable(candidate)) { setFeedback({ kind: 'error', message: 'აირჩიეთ ხელმისაწვდომი მძღოლი.' }); return; }
      chosen = { kind: 'roster', id: candidate.id };
    } else {
      if (!temporaryName.trim()) { setFeedback({ kind: 'error', message: 'მიუთითეთ მძღოლი.' }); return; }
      chosen = { kind: 'temporary', name: temporaryName.trim(), capacity: temporaryCapacity };
    }
    void changeTrip(editor.action, chosen, editor.action === 'replace' ? editor.removeKey : undefined);
  }

  if (direction !== 'gori-tbilisi') return null;
  if (!time) return <section className="admin-trip-capacity" aria-label="რეისის ადგილები"><div className="admin-trip-capacity-empty"><CarFront size={24} /><p>აირჩიეთ დრო — ნახავთ მძღოლებს, დაკავებულ და თავისუფალ ადგილებს.</p></div></section>;

  const editable = !!visibleTrip?.active && writeReady && !busy;
  const managementId = `trip-driver-management-${date}-${time.replace(':', '-')}`;
  const selectedCandidate = visibleTrip?.availableDrivers.find(driver => driver.id === Number(driverId));
  const candidateMoved = selectedCandidate && selectedCandidate.assignedTime && selectedCandidate.assignedTime !== time;
  const canSubmit = editable && !!editor && (selectionKind === 'temporary' ? !!temporaryName.trim() : !!selectedCandidate && candidateAvailable(selectedCandidate));
  const replacedMissing = editor?.action === 'replace' && !visibleTrip?.drivers.some(driver => driver.key === editor.removeKey);

  return <section className="admin-trip-capacity" aria-label="რეისის ადგილები" data-trip-time={time} data-trip-date={date}>
    <header className="admin-trip-capacity-heading">
      <div className="admin-trip-capacity-title"><span className="admin-trip-capacity-icon"><CarFront size={24} /></span><div><h2>რეისის ადგილები</h2><p><strong>{time}</strong> · {dateLabel(date)} · გორი → თბილისი</p></div></div>
      {visibleTrip && <button type="button" className="admin-trip-capacity-toggle" aria-expanded={expanded} aria-controls={managementId} onClick={() => { setExpanded(value => !value); setEditor(null); }} disabled={busy}><Settings2 size={17} /><span>მძღოლების მართვა</span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>}
    </header>
    {loading && !visibleTrip && <div className="admin-trip-capacity-loading" role="status"><LoaderCircle size={18} className="admin-spin" />რეისის ადგილები იტვირთება…</div>}
    {readError && <div className="admin-trip-capacity-feedback error" role="alert"><AlertCircle size={16} /><span>{readError}</span><button type="button" className="admin-trip-capacity-button" onClick={() => { setLoading(!visibleTrip); setRetry(value => value + 1); }} disabled={busy}><RefreshCw size={14} />ხელახლა ცდა</button></div>}
    {visibleTrip && <>
      <div className="admin-trip-capacity-summary" aria-label="ადგილების შეჯამება">
        <div className="admin-trip-capacity-stat"><span>სულ ადგილები</span><strong data-trip-total>{visibleTrip.totalSeats}</strong></div>
        <div className="admin-trip-capacity-stat"><span>დაკავებული</span><strong data-trip-booked>{visibleTrip.bookedSeats}</strong></div>
        <div className="admin-trip-capacity-stat free"><span>თავისუფალი</span><strong data-trip-free>{visibleTrip.freeSeats}</strong></div>
        {visibleTrip.uncoveredSeats > 0 && <div className="admin-trip-capacity-stat over"><span>მძღოლის გარეშე</span><strong data-trip-uncovered>{visibleTrip.uncoveredSeats}</strong></div>}
      </div>
      {!visibleTrip.active && <p className="admin-trip-capacity-warning"><AlertCircle size={16} /><span>ეს დრო განრიგში გამორთულია. არსებული ჯავშნები შენარჩუნებულია; მძღოლების ცვლილებისთვის ჯერ ჩართეთ დრო პარამეტრებში.</span></p>}
      <div className="admin-trip-capacity-cars">
        {visibleTrip.drivers.map(driver => <DriverCard key={driver.key} driver={driver} manage={expanded} editable={editable} onReplace={() => openEditor({ action: 'replace', removeKey: driver.key, name: driver.name })} onRemove={() => void changeTrip('remove', undefined, driver.key)} />)}
        {visibleTrip.uncoveredSeats > 0 && <div className="admin-trip-capacity-car uncovered" data-driver-uncovered>
          <div className="admin-trip-capacity-car-head"><div><span className="admin-trip-capacity-car-name"><UserRound size={17} /><strong>მძღოლის გარეშე</strong></span><small>დაამატეთ მანქანა ამ დროზე.</small></div><span className="admin-trip-capacity-car-count">{visibleTrip.uncoveredSeats} ადგილი</span></div>
          <SeatCells count={visibleTrip.uncoveredSeats} filled={0} label={`${visibleTrip.uncoveredSeats} ადგილი მძღოლის გარეშე`} limit={24} />
        </div>}
      </div>
      {visibleTrip.drivers.length === 0 && visibleTrip.uncoveredSeats === 0 && <div className="admin-trip-capacity-empty"><CarFront size={20} /><p>ამ დროზე მძღოლი ჯერ არ არის დამატებული.</p></div>}
      {feedback && <div className={`admin-trip-capacity-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}<span>{feedback.message}</span></div>}
      {expanded && <div id={managementId} className="admin-trip-capacity-management">
        {!editor ? <div className="admin-trip-capacity-car-actions"><button type="button" className="admin-trip-capacity-button primary" onClick={() => openEditor({ action: 'add' })} disabled={!editable}><Plus size={17} />მძღოლის დამატება</button></div> : <form className="admin-trip-capacity-editor" onSubmit={saveSelection}>
          <h3>{editor.action === 'replace' ? `${editor.name} — მძღოლის შეცვლა` : 'მძღოლის დამატება ამ რეისზე'}</h3>
          <div className="admin-trip-capacity-editor-tabs" role="group" aria-label="მძღოლის არჩევის ტიპი"><button type="button" className={selectionKind === 'roster' ? 'active' : ''} aria-pressed={selectionKind === 'roster'} onClick={() => setSelectionKind('roster')} disabled={busy}>არსებული მძღოლი</button><button type="button" className={selectionKind === 'temporary' ? 'active' : ''} aria-pressed={selectionKind === 'temporary'} onClick={() => setSelectionKind('temporary')} disabled={busy}>სხვა მძღოლი</button></div>
          <div className="admin-trip-capacity-editor-fields">
            {selectionKind === 'roster' ? <label>მძღოლი<select aria-label="რეისზე დასამატებელი მძღოლი" value={driverId} onChange={event => setDriverId(event.target.value)} disabled={!editable}><option value="">აირჩიეთ მძღოლი</option>{visibleTrip.availableDrivers.map(driver => {
              const alreadySelected = visibleTrip.drivers.some(assigned => assigned.driverId === driver.id);
              const where = driver.declined ? 'უარი ამ დღეზე' : alreadySelected ? 'ამ რეისზეა' : driver.assignedTime ? `${driver.assignedTime}${driver.assignmentActive ? '' : ' — გამორთული დრო'}` : 'რეზერვი';
              return <option key={driver.id} value={driver.id} disabled={!candidateAvailable(driver)}>{driver.name} · {driver.capacity} ადგილი · {where}</option>;
            })}</select></label> : <><label>მძღოლი<input aria-label="სხვა მძღოლის სახელი" value={temporaryName} maxLength={100} placeholder="მძღოლი" onChange={event => setTemporaryName(event.target.value)} disabled={!editable} required /></label><label className="capacity">ადგილები<select aria-label="სხვა მძღოლის ადგილები" value={temporaryCapacity} onChange={event => setTemporaryCapacity(Number(event.target.value))} disabled={!editable}>{Array.from({ length: 8 }, (_, index) => index + 1).map(capacity => <option value={capacity} key={capacity}>{capacity}</option>)}</select></label></>}
            <div className="admin-trip-capacity-editor-buttons"><button type="submit" className="admin-trip-capacity-button primary" disabled={!canSubmit || replacedMissing}>{busy ? <LoaderCircle size={16} className="admin-spin" /> : editor.action === 'replace' ? <ArrowRightLeft size={16} /> : <Plus size={16} />}{editor.action === 'replace' ? 'შეცვლა' : 'დამატება'}</button><button type="button" className="admin-trip-capacity-button" onClick={() => setEditor(null)} disabled={busy}><X size={16} />გაუქმება</button></div>
          </div>
          {candidateMoved && <p className="admin-trip-capacity-editor-note"><Clock3 size={12} /> {selectedCandidate.name} გადავა {selectedCandidate.assignedTime}-დან {time}-ზე.</p>}
          {selectionKind === 'temporary' && <p className="admin-trip-capacity-editor-note">ეს მძღოლი დაემატება მხოლოდ ამ თარიღსა და დროზე.</p>}
          {replacedMissing && <p className="admin-trip-capacity-warning"><AlertCircle size={15} /><span>შესაცვლელი მძღოლი ამ რეისზე აღარ არის. დახურეთ არჩევანი და გადაამოწმეთ რეისი.</span></p>}
        </form>}
      </div>}
    </>}
  </section>;
}

function SeatCells({ count, filled, label, limit = 8 }: { count: number; filled: number; label: string; limit?: number }) {
  const shown = Math.min(count, limit);
  return <div className="admin-trip-capacity-seats" role="img" aria-label={label}>{Array.from({ length: shown }, (_, index) => <span key={index} className={`admin-trip-capacity-seat${index < filled ? ' filled' : ''}`} aria-hidden="true"><UserRound size={14} /></span>)}{count > shown && <span className="admin-trip-capacity-more-seats" aria-hidden="true">+{count - shown}</span>}</div>;
}

function DriverCard({ driver, manage, editable, onReplace, onRemove }: { driver: TripDriver; manage: boolean; editable: boolean; onReplace: () => void; onRemove: () => void }) {
  const full = driver.active && driver.filledSeats === driver.capacity;
  return <div className={`admin-trip-capacity-car${full ? ' full' : ''}${driver.active ? '' : ' inactive'}`} data-trip-driver={driver.key}>
    <div className="admin-trip-capacity-car-head"><div><span className="admin-trip-capacity-car-name"><CarFront size={17} /><strong>{driver.name}</strong></span><small>{!driver.active ? 'დრო გამორთულია' : full ? 'ყველა ადგილი შევსებულია' : `${driver.freeSeats} თავისუფალი ადგილი`}{driver.kind === 'temporary' ? ' · ამ რეისზე' : ''}</small></div><span className="admin-trip-capacity-car-count">{driver.filledSeats} / {driver.capacity}</span></div>
    <SeatCells count={driver.capacity} filled={driver.filledSeats} label={`${driver.name}: ${driver.filledSeats} დაკავებული, ${driver.freeSeats} თავისუფალი ადგილი`} />
    {manage && <div className="admin-trip-capacity-car-actions"><button type="button" className="admin-trip-capacity-button" aria-label={`${driver.name} — რეისის მძღოლის შეცვლა`} onClick={onReplace} disabled={!editable}><ArrowRightLeft size={15} />შეცვლა</button><button type="button" className="admin-trip-capacity-button danger" aria-label={`${driver.name} — ამ რეისიდან მოხსნა`} onClick={onRemove} disabled={!editable}><Trash2 size={15} />მოხსნა</button></div>}
  </div>;
}
