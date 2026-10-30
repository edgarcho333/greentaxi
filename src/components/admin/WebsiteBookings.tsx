import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, CalendarDays, Check, Clock3, Edit3, Globe2, LoaderCircle, MapPin, Phone, RefreshCw, Save, Users, X } from 'lucide-react';
import { ApiError, directions, request, today, type Booking, type Direction, type PublicConfig, type Schedule, type WholeCarOptions } from '../../api';
import { formatPhone, normalizePhone, phoneDialNumber } from '../../../shared/phone';
import { BookingOptions, BookingOptionsSummary, type BookingOptionsValue } from './BookingOptions';
import { BookingTypeFields, BookingTypeSummary, type BookingTypeValue } from './BookingTypeFields';
import './website-bookings.css';

type PageResult = { bookings: Booking[]; total: number; page: number; pageSize: number };
type Fields = BookingOptionsValue & BookingTypeValue & {
  phone: string; callerPhone: string; direction: Direction; seats: number; goriAddress: string;
  pickupStopId: number | null; requestedDate: string; requestedTime: string;
};
type MutationKind = 'save' | 'confirm' | 'reject';
type Attempt = { kind: MutationKind; id: number; path: string; method: 'PATCH' | 'POST'; body: string; key: string; ambiguous: boolean };
const PAGE_SIZE = 15;
const dateLabel = (value: string) => value.split('-').reverse().join('/');
const futureTime = (date: string, time: string, now = Date.now()) => /^\d{2}:\d{2}$/.test(time) && new Date(`${date}T${time}:00+04:00`).getTime() > now;
const message = (error: unknown) => error instanceof Error ? error.message : 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.';

export default function WebsiteBookings({ config, onClose, onChange }: {
  config: PublicConfig; onClose: () => void; onChange: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const mounted = useRef(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [conflictId, setConflictId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const selectedRevisions = useRef(new Map<number, { updatedAt: string; revision: string }>());
  const sequence = useRef(0);
  const lastEdited = useRef<number | null>(null);
  const locked = busy || attempt !== null;

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('[data-website-close]')?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[data-whole-car-dialog]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current && !attemptRef.current) closeRef.current();
      } else if (event.key === 'Tab') {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      mounted.current = false;
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = previous;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | null = null;
    const currentSequence = ++sequence.current;
    setLoading(true);
    const load = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true; controller = new AbortController();
      const signal = controller.signal;
      try {
        const data = await request<PageResult>(`/admin/website-bookings?page=${page}&pageSize=${PAGE_SIZE}`, { signal });
        if (!active || signal.aborted || sequence.current !== currentSequence) return;
        setResult(data); setListError('');
        if (page > 1 && (page - 1) * PAGE_SIZE >= data.total) setPage(Math.max(1, Math.ceil(data.total / PAGE_SIZE)));
      } catch (cause) {
        if (active && !signal.aborted && sequence.current === currentSequence) setListError(message(cause));
      } finally {
        inFlight = false;
        if (active && sequence.current === currentSequence) setLoading(false);
      }
    };
    void load();
    const visible = () => { if (document.visibilityState !== 'hidden' && !busyRef.current) void load(); };
    const timer = window.setInterval(visible, 5_000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => {
      active = false; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, [page, revision]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (editing) dialog.current?.querySelector<HTMLElement>('[data-website-booking-editor] input')?.focus();
      else if (lastEdited.current !== null) dialog.current?.querySelector<HTMLElement>(`[data-website-booking-id="${lastEdited.current}"] [data-website-booking-edit]`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing?.id, editorVersion]);

  function close() { if (!busyRef.current && !attemptRef.current) onClose(); }
  function openEditor(booking: Booking) {
    if (busyRef.current || attemptRef.current || editing) return;
    lastEdited.current = booking.id; setEditing(booking); setRejectId(null); setError(''); setFeedback(''); setConflictId(null);
  }
  function closeEditor() { if (!busyRef.current && !attemptRef.current) { setEditing(null); setError(''); setConflictId(null); } }

  async function send(next: Attempt) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setFeedback('');
    attemptRef.current = next; setAttempt(next);
    try {
      const saved = await request<Booking>(next.path, { method: next.method, headers: { 'Idempotency-Key': next.key }, body: next.body });
      if (!mounted.current) return;
      // Retire any older list response before showing the mutation result. A
      // quick Confirm after Save must use the returned version immediately.
      sequence.current++;
      setResult(current => current ? { ...current,
        bookings: next.kind === 'save' ? current.bookings.map(row => row.id === next.id ? saved : row) : current.bookings.filter(row => row.id !== next.id),
        total: next.kind === 'save' ? current.total : Math.max(0, current.total - 1),
      } : current);
      if (next.kind === 'save') {
        const submitted = JSON.parse(next.body) as { expectedVehicleRevision?: string };
        if (saved.bookingType === 'whole_car' && submitted.expectedVehicleRevision) selectedRevisions.current.set(saved.id, { updatedAt: saved.updatedAt, revision: submitted.expectedVehicleRevision });
        else selectedRevisions.current.delete(saved.id);
        setEditing(null);
      } else selectedRevisions.current.delete(next.id);
      attemptRef.current = null; setAttempt(null); setRejectId(null); setConflictId(null);
      setFeedback(next.kind === 'save' ? 'ცვლილებები შენახულია. განაცხადი დადასტურებას ელოდება.' : next.kind === 'confirm' ? 'ჯავშანი დადასტურებულია.' : 'განაცხადი უარყოფილია.');
      setRevision(value => value + 1); changeRef.current();
    } catch (cause) {
      if (!mounted.current) return;
      const definite = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      const needsLogin = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (definite && !(next.ambiguous && needsLogin)) {
        attemptRef.current = null; setAttempt(null); setError(message(cause));
        if (cause instanceof ApiError && (cause.code === 'BOOKING_CHANGED' || cause.code === 'NOT_FOUND')) { setConflictId(next.id); setRevision(value => value + 1); }
      } else {
        const pending = { ...next, ambiguous: true };
        attemptRef.current = pending; setAttempt(pending);
        setError(needsLogin ? 'სესია დასრულდა. სხვა ჩანართში ხელახლა შედით იმავე ანგარიშით და გაიმეორეთ გაგზავნა.' : 'პასუხი ვერ მივიღეთ. ხელახლა გაგზავნა იმავე მოთხოვნას შეამოწმებს.');
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function mutate(kind: MutationKind, booking: Booking, body: Record<string, unknown> = {}) {
    if (busyRef.current || attemptRef.current) return;
    const path = `/admin/website-bookings/${booking.id}${kind === 'save' ? '' : `/${kind}`}`;
    void send({ kind, id: booking.id, path, method: kind === 'save' ? 'PATCH' : 'POST', body: JSON.stringify({ ...body, expectedUpdatedAt: booking.updatedAt }), key: crypto.randomUUID(), ambiguous: false });
  }

  async function confirm(booking: Booking) {
    if (editing || busyRef.current || attemptRef.current) return;
    if (booking.bookingType !== 'whole_car') { mutate('confirm', booking); return; }
    busyRef.current = true; setBusy(true); setError(''); setFeedback('');
    let vehicleRevision: string | undefined;
    try {
      const options = await request<WholeCarOptions>(`/admin/trips/whole-car-options?${new URLSearchParams({ direction: booking.direction, date: booking.requestedDate, time: booking.requestedTime })}`);
      if (!mounted.current) return;
      const car = options.drivers.find(candidate => candidate.key === booking.assignedVehicleKey);
      if (!options.active || !car || car.reservedBookingId && car.reservedBookingId !== booking.id) throw new Error('არჩეული მანქანა ამ დროზე აღარ არის ხელმისაწვდომი. გახსენით რედაქტირება და აირჩიეთ მანქანა.');
      if (car.capacity !== booking.seats || car.name !== booking.assignedVehicleName) throw new Error('მძღოლის მონაცემები შეიცვალა. გახსენით რედაქტირება და შეამოწმეთ არჩეული მანქანა.');
      const selected = selectedRevisions.current.get(booking.id);
      const requiresChoice = car.declined || !(car.assignedTimes ?? (car.assignedTime ? [car.assignedTime] : [])).includes(booking.requestedTime);
      if (requiresChoice && (!selected || selected.updatedAt !== booking.updatedAt || selected.revision !== car.revision)) throw new Error('მძღოლის არჩევა დასადასტურებელია. გახსენით რედაქტირება და ხელახლა აირჩიეთ მძღოლი.');
      vehicleRevision = selected?.updatedAt === booking.updatedAt ? selected.revision : car.revision;
    } catch (cause) {
      if (mounted.current) setError(message(cause));
      return;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    if (mounted.current) mutate('confirm', booking, { assignedVehicleKey: booking.assignedVehicleKey, expectedVehicleRevision: vehicleRevision });
  }

  async function reloadBooking() {
    if (!editing || busyRef.current || attemptRef.current) return;
    const expectedId = editing.id;
    setError('');
    busyRef.current = true; setBusy(true);
    try {
      const fresh = await request<Booking>(`/admin/website-bookings/${expectedId}`);
      if (!mounted.current) return;
      setEditing(fresh); setEditorVersion(value => value + 1); setConflictId(null); setRevision(value => value + 1);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && (cause.code === 'BOOKING_CHANGED' || cause.code === 'NOT_FOUND')) { setEditing(null); setConflictId(null); setFeedback('ეს განაცხადი უკვე დამუშავებულია.'); setRevision(value => value + 1); }
      else setError(message(cause));
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const visibleEdited = editing ? result?.bookings.find(booking => booking.id === editing.id) : null;
  // Absence from a paginated response does not establish that a request was
  // processed: other administrators may simply have shifted its page.
  const stale = !!editing && (conflictId === editing.id || !!visibleEdited && visibleEdited.updatedAt !== editing.updatedAt);
  return createPortal(<div className="website-bookings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} className={`website-bookings-dialog${editing ? ' is-editing' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy} tabIndex={-1} data-website-bookings-dialog>
      <header className="website-bookings-heading"><div><Globe2 size={27} /><h2 id={`${id}-title`}>საიტის ჯავშნები</h2><span className="website-bookings-count" aria-label={`${total} დასამუშავებელი განაცხადი`}>{total}</span></div><button type="button" className="website-icon-button" data-website-close disabled={locked} onClick={close} aria-label="საიტის ჯავშნების დახურვა"><X size={25} /></button></header>
      <div className="website-bookings-feedback" aria-live="polite">
        {feedback && <p className="website-feedback success" role="status"><Check size={20} />{feedback}</p>}
        {error && <p className="website-feedback error" role="alert">{error}</p>}
        {busy && <p className="website-form-hint" role="status"><LoaderCircle size={18} className="admin-spin" /> მოთხოვნა იგზავნება…</p>}
        {attempt && !busy && <div className="website-pending" role="status"><span>მოთხოვნის შედეგი გადასამოწმებელია. ცვლილებები დაბლოკილია.</span><button type="button" className="website-button primary" data-website-booking-retry onClick={() => void send(attempt)}>განმეორებით გაგზავნა</button></div>}
      </div>
      <div className="website-bookings-workspace">
        <section className="website-bookings-list" aria-label="საიტის განაცხადების სია">
          <div className="website-bookings-list-heading"><h3>ახალი მოთხოვნები</h3><button type="button" className="website-icon-button" disabled={locked || loading} onClick={() => setRevision(value => value + 1)} aria-label="საიტის განაცხადების განახლება"><RefreshCw size={21} /></button></div>
          {listError && <div className="website-feedback error" role="alert"><span>{listError}</span><button type="button" className="website-button" disabled={locked} onClick={() => setRevision(value => value + 1)}>ხელახლა ცდა</button></div>}
          {loading && !result && <p className="website-empty" role="status"><LoaderCircle size={24} className="admin-spin" />განაცხადები იტვირთება…</p>}
          {result?.bookings.map(booking => <article key={booking.id} data-website-booking-id={booking.id} className={`website-booking-card${editing?.id === booking.id ? ' selected' : ''}`}>
            <div className="website-booking-card-top"><span className="website-booking-new">ახალი</span><span>#{booking.id}</span><button type="button" className="website-button website-edit" data-website-booking-edit disabled={locked || editing !== null} onClick={() => openEditor(booking)}><Edit3 size={19} />რედაქტირება</button></div>
            <h3>{directions[booking.direction]}</h3>
            <div className="website-booking-trip"><span><CalendarDays size={19} />{dateLabel(booking.requestedDate)}</span><strong><Clock3 size={19} />{booking.requestedTime}</strong><span><Users size={19} />{booking.bookingType && booking.bookingType !== 'passenger' ? <BookingTypeSummary {...booking} /> : `${booking.seats} ადგილი`}</span></div>
            <p className="website-booking-address"><MapPin size={20} /><span>{booking.direction === 'gori-tbilisi' ? booking.goriAddress : `${booking.pickupStopName || 'თბილისი'} → ${booking.goriAddress}`}</span></p>
            <div className="website-booking-contact"><a href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`}><Phone size={20} />{formatPhone(booking.phone)}</a>{booking.callerPhone && normalizePhone(booking.callerPhone) !== normalizePhone(booking.phone) && <small>ზარის ნომერი: {formatPhone(booking.callerPhone)}</small>}</div>
            <BookingOptionsSummary luggage={booking.luggage} dog={booking.dog} seatPreference={booking.seatPreference} />
            <div className="website-booking-actions"><button type="button" className="website-button primary" data-website-booking-confirm disabled={locked || editing !== null || conflictId === booking.id} onClick={() => void confirm(booking)}><Check size={22} />დადასტურება</button><button type="button" className="website-button danger" data-website-booking-reject disabled={locked || editing !== null} aria-expanded={rejectId === booking.id} onClick={() => { setRejectId(rejectId === booking.id ? null : booking.id); setError(''); }}><X size={22} />უარი</button></div>
            {rejectId === booking.id && <div className="website-reject-confirm" role="group" aria-label="განაცხადის უარყოფა"><p>ნამდვილად გსურთ განაცხადის უარყოფა?</p><button type="button" className="website-button danger" data-website-booking-reject-confirm disabled={locked} onClick={() => mutate('reject', booking)}>უარის დადასტურება</button><button type="button" className="website-button" disabled={locked} onClick={() => setRejectId(null)}>გაუქმება</button></div>}
          </article>)}
          {!loading && !listError && total === 0 && <div className="website-empty"><Check size={30} /><h3>ყველა განაცხადი დამუშავებულია</h3><p>ახალი ჯავშნები აქ გამოჩნდება.</p></div>}
          {pages > 1 && <nav className="website-pagination" aria-label="საიტის განაცხადების გვერდები"><button type="button" className="website-button" disabled={page === 1 || locked || editing !== null} onClick={() => setPage(value => value - 1)}>წინა</button><span>{page} / {pages}</span><button type="button" className="website-button" disabled={page >= pages || locked || editing !== null} onClick={() => setPage(value => value + 1)}>შემდეგი</button></nav>}
        </section>
        {editing && <WebsiteBookingEditor key={`${editing.id}:${editorVersion}`} booking={editing} config={config} locked={locked} stale={stale} onClose={closeEditor} onReload={() => void reloadBooking()} onSubmit={fields => mutate('save', editing, fields)} />}
      </div>
      <footer className="website-bookings-footer">დასამუშავებელია: <strong>{total}</strong></footer>
    </section>
  </div>, document.body);
}

function WebsiteBookingEditor({ booking, config, locked, stale, onClose, onReload, onSubmit }: {
  booking: Booking; config: PublicConfig; locked: boolean; stale: boolean; onClose: () => void; onReload: () => void; onSubmit: (fields: Record<string, unknown>) => void;
}) {
  const [fields, setFields] = useState<Fields>(() => ({
    phone: formatPhone(booking.phone), callerPhone: formatPhone(booking.callerPhone || ''), direction: booking.direction,
    seats: booking.seats > 0 && booking.seats <= 8 ? booking.seats : 1, goriAddress: booking.goriAddress,
    pickupStopId: booking.pickupStopId, requestedDate: booking.requestedDate, requestedTime: booking.requestedTime,
    luggage: booking.luggage ?? false, dog: booking.dog ?? false, seatPreference: booking.seatPreference ?? null,
    bookingType: booking.bookingType ?? 'passenger', assignedVehicleKey: booking.assignedVehicleKey || '',
  }));
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleRevision, setScheduleRevision] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const [validation, setValidation] = useState('');
  const context = `${fields.direction}:${fields.requestedDate}`;
  const latestContext = useRef(context); latestContext.current = context;
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController(); setScheduleLoading(true); setScheduleError(''); setSchedule(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.requestedDate)) { setScheduleLoading(false); return () => controller.abort(); }
    void request<Schedule>(`/admin/schedule?${new URLSearchParams({ direction: fields.direction, date: fields.requestedDate })}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted || latestContext.current !== context) return;
      if (data.direction !== fields.direction || data.date !== fields.requestedDate) throw new Error('განრიგი ვერ განახლდა. სცადეთ ხელახლა.');
      setSchedule(data);
    }).catch(cause => { if (!controller.signal.aborted && latestContext.current === context) setScheduleError(message(cause)); }).finally(() => { if (!controller.signal.aborted && latestContext.current === context) setScheduleLoading(false); });
    return () => controller.abort();
  }, [fields.direction, fields.requestedDate, context, scheduleRevision]);
  const updateType = useCallback((value: BookingTypeValue) => setFields(current => ({ ...current, ...value, seatPreference: value.bookingType === 'passenger' ? current.seatPreference : null })), []);
  function update<K extends keyof Fields>(key: K, value: Fields[K]) {
    if (locked) return;
    setFields(current => ({ ...current, [key]: value, ...(['direction', 'requestedDate', 'requestedTime'].includes(key) ? { assignedVehicleKey: '', expectedVehicleRevision: undefined } : {}) }));
    setValidation('');
  }
  const times = schedule?.slots.filter(slot => slot.active && futureTime(fields.requestedDate, slot.time, clock)).map(slot => slot.time) ?? [];
  const timeValid = !scheduleLoading && !scheduleError && times.includes(fields.requestedTime);
  const allowedStops = config.stops.filter(stop => stop.active || stop.id === booking.pickupStopId);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || stale) return;
    const phone = normalizePhone(fields.phone), callerPhone = fields.callerPhone.trim() ? normalizePhone(fields.callerPhone) : null;
    if (!phone || fields.callerPhone.trim() && !callerPhone) { setValidation('მიუთითეთ სწორი ტელეფონის ნომერი.'); return; }
    if (fields.goriAddress.trim().length < 3 || fields.goriAddress.length > 500) { setValidation('მიუთითეთ სრული მისამართი გორში.'); return; }
    if (fields.requestedDate < today() || !timeValid || !futureTime(fields.requestedDate, fields.requestedTime)) { setValidation('აირჩიეთ მომავალი მოქმედი თარიღი და დრო.'); return; }
    if (fields.direction === 'tbilisi-gori' && !fields.pickupStopId) { setValidation('აირჩიეთ გაჩერება თბილისში.'); return; }
    if (fields.bookingType === 'whole_car' && (!fields.assignedVehicleKey || fields.direction !== 'gori-tbilisi')) { setValidation('აირჩიეთ მანქანა გორი → თბილისი რეისისთვის.'); return; }
    onSubmit({ ...fields, phone, callerPhone, goriAddress: fields.goriAddress.trim(), seats: fields.bookingType === 'passenger' ? fields.seats : 0, pickupStopId: fields.direction === 'tbilisi-gori' ? fields.pickupStopId : null, assignedVehicleKey: fields.bookingType === 'whole_car' ? fields.assignedVehicleKey : null, seatPreference: fields.bookingType === 'passenger' ? fields.seatPreference : null });
  }
  return <section className="website-booking-editor" data-website-booking-editor aria-labelledby={`website-edit-${booking.id}`}>
    <header><h3 id={`website-edit-${booking.id}`}><Edit3 size={22} />ჯავშნის რედაქტირება</h3><button type="button" className="website-button" disabled={locked} onClick={onClose} aria-label="რედაქტირების დახურვა"><ArrowLeft size={20} />უკან</button></header>
    <form onSubmit={submit} noValidate>
      <div className="website-editor-fields">
        {stale && <div className="website-stale" role="status"><p>განაცხადი შეიცვალა ან უკვე დამუშავებულია. თქვენი ველები შენარჩუნებულია. განაახლეთ მონაცემები და შეამოწმეთ.</p><button type="button" className="website-button" data-website-booking-reload disabled={locked} onClick={onReload}><RefreshCw size={20} />მონაცემების განახლება</button></div>}
        <fieldset className="website-fieldset" aria-label="მიმართულება"><legend>მიმართულება</legend><div className="website-directions">{Object.entries(directions).map(([value, label]) => <button type="button" className="website-button" key={value} aria-pressed={fields.direction === value} disabled={locked} onClick={() => update('direction', value as Direction)}>{label}</button>)}</div></fieldset>
        <div className="website-two-fields"><label>თარიღი<input type="date" min={today()} value={fields.requestedDate} disabled={locked} onChange={event => update('requestedDate', event.target.value)} /></label><label>დრო<select value={fields.requestedTime} disabled={locked || scheduleLoading || !!scheduleError} onChange={event => update('requestedTime', event.target.value)}><option value="">აირჩიეთ დრო</option>{fields.requestedTime && !times.includes(fields.requestedTime) && <option value={fields.requestedTime} disabled>{fields.requestedTime} · მიუწვდომელია</option>}{times.map(time => <option key={time} value={time}>{time}</option>)}</select></label></div>
        {scheduleLoading && <p className="website-form-hint" role="status">დროები იტვირთება…</p>}
        {scheduleError && <div className="website-feedback error" role="alert"><span>{scheduleError}</span><button type="button" className="website-button" disabled={locked} onClick={() => setScheduleRevision(value => value + 1)}>განრიგის განახლება</button></div>}
        {!scheduleLoading && !scheduleError && !times.length && <p className="website-form-hint">არჩეულ დღეს მომავალი მოქმედი დრო არ არის.</p>}
        <div className="website-two-fields"><label>ტელეფონის ნომერი<input type="tel" autoComplete="off" value={fields.phone} maxLength={30} disabled={locked} onChange={event => update('phone', event.target.value)} /></label><label>ზარის ნომერი<input type="tel" autoComplete="off" value={fields.callerPhone} maxLength={30} disabled={locked} placeholder="არასავალდებულო" onChange={event => update('callerPhone', event.target.value)} /></label></div>
        {fields.direction === 'tbilisi-gori' && <label>თბილისის გაჩერება<select value={fields.pickupStopId ?? ''} disabled={locked} onChange={event => update('pickupStopId', event.target.value ? Number(event.target.value) : null)}><option value="">აირჩიეთ გაჩერება</option>{allowedStops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}{!stop.active ? ' · გამორთულია' : ''}</option>)}</select></label>}
        <label>{fields.direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'}<textarea rows={2} maxLength={500} value={fields.goriAddress} disabled={locked} onChange={event => update('goriAddress', event.target.value)} /></label>
        <BookingOptions value={fields} passenger={fields.bookingType === 'passenger'} disabled={locked} onChange={value => setFields(current => ({ ...current, ...value }))} typeControls={<BookingTypeFields inline deferredConfirmation value={fields} onChange={updateType} direction={fields.direction} date={fields.requestedDate} time={fields.requestedTime} bookingId={booking.id} disabled={locked} />} />
        {fields.bookingType === 'passenger' && <fieldset className="website-fieldset" aria-label="ადგილების რაოდენობა"><legend>ადგილების რაოდენობა</legend><div className="website-seats">{Array.from({ length: 8 }, (_, index) => index + 1).map(count => <button type="button" className="website-button" key={count} aria-label={`${count} ადგილი`} aria-pressed={fields.seats === count} disabled={locked} onClick={() => update('seats', count)}>{count}</button>)}</div></fieldset>}
        <p className="website-form-hint">შენახვა განაცხადს არ ადასტურებს. დადასტურება ცალკე ღილაკით ხდება.</p>
        {validation && <p className="website-feedback error" role="alert">{validation}</p>}
      </div>
      <footer className="website-editor-footer"><button type="button" className="website-button" disabled={locked} onClick={onClose}>გაუქმება</button><button type="submit" className="website-button primary" data-website-booking-save disabled={locked || stale || !timeValid}><Save size={21} />შენახვა</button></footer>
    </form>
  </section>;
}
