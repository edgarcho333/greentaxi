import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CarFront, CheckCircle2, Clock3, Dog, Download, Leaf, LoaderCircle, LogOut, Luggage, MapPin, Package, Phone, RefreshCw, UsersRound, X } from 'lucide-react';
import { ApiError, directions, request, type DriverBooking, type DriverDashboard, type DriverDayStatus, type DriverIdentity, type DriverSession } from '../api';
import { formatPhone, normalizePhone, phoneDialNumber } from '../../shared/phone';
import { groupTravelBookings, type TravelBookingGroup } from '../../shared/travel-groups';
import './driver-portal.css';

type Calendar = { today: string; tomorrow: string };
type Auth = { state: 'loading' } | { state: 'anonymous' } | { state: 'error'; message: string } | { state: 'authenticated'; session: DriverSession & { driver: DriverIdentity } };
type Feedback = { date: string; kind: 'success' | 'error'; message: string } | null;
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'დაკავშირება ვერ მოხერხდა. სცადეთ ხელახლა.';
const dateLabel = (date: string) => date.split('-').reverse().join('/');
const unauthorized = (cause: unknown) => cause instanceof ApiError && cause.status === 401;

export default function DriverPortal() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const acceptSession = useCallback((session: DriverSession) => {
    if (session.driver) setAuth({ state: 'authenticated', session: { ...session, driver: session.driver } });
    else setAuth({ state: 'anonymous' });
  }, []);
  const loadSession = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    const current = ++sequence.current;
    setAuth({ state: 'loading' });
    try {
      const session = await request<DriverSession>('/driver/auth/session', { signal: next.signal });
      if (mounted.current && sequence.current === current && !next.signal.aborted) acceptSession(session);
    } catch (cause) {
      if (mounted.current && sequence.current === current && !next.signal.aborted) setAuth(unauthorized(cause) ? { state: 'anonymous' } : { state: 'error', message: message(cause) });
    }
  }, [acceptSession]);
  useEffect(() => { mounted.current = true; void loadSession(); return () => { mounted.current = false; sequence.current++; controller.current?.abort(); }; }, [loadSession]);
  const expired = useCallback(() => { setNotice('სესია დასრულდა. შედით ხელახლა.'); setAuth({ state: 'anonymous' }); }, []);

  if (auth.state === 'authenticated') return <DriverHome key={auth.session.driver.id} session={auth.session} onExpired={expired} onLogout={async () => {
    try { await request('/driver/auth/logout', { method: 'POST', body: '{}' }); }
    catch (cause) { if (!unauthorized(cause)) throw cause; }
    setNotice(''); setAuth({ state: 'anonymous' });
  }} />;
  if (auth.state === 'loading' || auth.state === 'error') return <main className="driver-portal driver-portal-loading"><DriverBrand />{auth.state === 'loading' ? <p role="status"><LoaderCircle size={30} className="driver-spin" />იტვირთება…</p> : <><p className="driver-feedback error" role="alert">{auth.message}</p><button className="driver-button" onClick={() => void loadSession()}><RefreshCw size={23} />ხელახლა ცდა</button></>}</main>;
  return <DriverLogin notice={notice} onLogin={session => { setNotice(''); acceptSession(session); }} />;
}

function DriverBrand() {
  return <a href="/" className="driver-brand" aria-label="GreenTaxi — მთავარი გვერდი"><Leaf size={31} /><span><strong>Green</strong>Taxi</span></a>;
}

function DriverLogin({ notice, onLogin }: { notice: string; onLogin: (session: DriverSession) => void }) {
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current) return;
    const normalized = normalizePhone(phone);
    if (!normalized || !/^5\d{8}$/.test(normalized)) { setError('შეიყვანეთ მობილურის სწორი ნომერი, მაგალითად: 599 12 34 56.'); return; }
    saving.current = true; setBusy(true); setError('');
    try {
      const session = await request<DriverSession>('/driver/auth/login', { method: 'POST', body: JSON.stringify({ phone: normalized }) });
      if (!session.driver) throw new Error('შესვლა ვერ მოხერხდა. გადაამოწმეთ ტელეფონის ნომერი.');
      if (mounted.current) onLogin(session);
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return <main className="driver-portal driver-login-page"><DriverBrand /><section className="driver-login-card" aria-labelledby="driver-login-title"><span className="driver-login-icon"><CarFront size={34} /></span><h1 id="driver-login-title">მძღოლის შესვლა</h1><p id="driver-login-phone-help">შეიყვანეთ ადმინისტრატორთან მითითებული ტელეფონის ნომერი.</p>{notice && <p className="driver-feedback" role="status">{notice}</p>}<form onSubmit={submit} aria-busy={busy}>
    <label>ტელეფონის ნომერი<span className="driver-login-input"><Phone size={23} /><input aria-label="ტელეფონის ნომერი" aria-describedby={`driver-login-phone-help${error ? ' driver-login-phone-error' : ''}`} aria-invalid={error ? true : undefined} type="tel" inputMode="tel" value={phone} onChange={event => { setPhone(event.target.value); setError(''); }} onBlur={() => setPhone(value => formatPhone(value))} autoComplete="tel" placeholder="599 12 34 56" maxLength={32} required disabled={busy} /></span></label>
    {error && <p id="driver-login-phone-error" className="driver-feedback error" role="alert">{error}</p>}
    <button type="submit" className="driver-button primary driver-login-submit" disabled={busy}>{busy ? <LoaderCircle size={24} className="driver-spin" /> : <ArrowRight size={24} />}შესვლა</button>
  </form></section><a className="driver-download-link" href="/downloads/GreenTaxi-Driver-Android.apk" download><Download size={24} />Android აპის ჩამოტვირთვა</a><a className="driver-back-link" href="/"><ArrowLeft size={22} />მთავარ გვერდზე დაბრუნება</a></main>;
}

function DriverHome({ session, onExpired, onLogout }: { session: DriverSession & { driver: DriverIdentity }; onExpired: () => void; onLogout: () => Promise<void> }) {
  const [identity, setIdentity] = useState(session.driver);
  const [calendar, setCalendar] = useState<Calendar>({ today: session.today, tomorrow: session.tomorrow });
  const [selectedDay, setSelectedDay] = useState<0 | 1>(0);
  const [hourSelection, setHourSelection] = useState<{ date: string; time: string } | null>(null);
  const [days, setDays] = useState<DriverDayStatus[]>([]);
  const [record, setRecord] = useState<DriverDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [savingDate, setSavingDate] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const selectedDate = selectedDay === 0 ? calendar.today : calendar.tomorrow;
  const attendanceDate = selectedDate;
  const bookingsDate = selectedDate;
  const visible = record?.date === bookingsDate && record.today === calendar.today && record.tomorrow === calendar.tomorrow ? record : null;
  const dayStatus = days.find(day => day.date === attendanceDate);
  const visibleTrips = visible?.trips ?? (visible?.trip ? [visible.trip] : []);
  const availableTimes = [...new Set(visible ? [...visible.bookings.map(booking => booking.time), ...visibleTrips.map(trip => trip.time)] : [])].sort();
  const timeKey = availableTimes.join(',');
  const selectedTime = hourSelection?.date === selectedDate && availableTimes.includes(hourSelection.time) ? hourSelection.time : availableTimes[0] ?? null;
  const selectedBookings = visible?.bookings.filter(booking => booking.time === selectedTime) ?? [];
  const selectedGroups = groupTravelBookings(selectedBookings);
  const selectedTrip = visibleTrips.find(trip => trip.time === selectedTime);
  const reservedSeats = selectedBookings.reduce((total, booking) => total + (booking.bookingType === 'parcel' ? 0 : booking.seats), 0);
  const calendarRef = useRef(calendar); calendarRef.current = calendar;
  const selection = useRef(bookingsDate); selection.current = bookingsDate;
  const mounted = useRef(false);
  const mutation = useRef(false);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const sessionController = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readSequence.current++; readController.current?.abort(); sessionController.current?.abort(); }; }, []);
  useEffect(() => {
    if (!visible) return;
    setHourSelection(current => current?.date === selectedDate && availableTimes.includes(current.time) ? current : availableTimes.length ? { date: selectedDate, time: availableTimes[0] } : null);
  }, [selectedDate, timeKey, visible]);

  const adoptCalendar = useCallback((next: Calendar) => {
    const changed = calendarRef.current.today !== next.today || calendarRef.current.tomorrow !== next.tomorrow;
    if (changed) {
      calendarRef.current = next; setCalendar(next); setRecord(null); setDays([]); setFeedback(null); setHourSelection(null);
    }
    return changed;
  }, []);
  const refreshCalendar = useCallback(async () => {
    if (sessionController.current) return;
    const controller = new AbortController(); sessionController.current = controller;
    try {
      const result = await request<DriverSession>('/driver/auth/session', { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      if (!result.driver || result.driver.id !== session.driver.id) { onExpired(); return; }
      setIdentity(result.driver); adoptCalendar(result);
    } catch (cause) { if (mounted.current && !controller.signal.aborted && unauthorized(cause)) onExpired(); }
    finally { if (sessionController.current === controller) sessionController.current = null; }
  }, [session.driver.id, onExpired, adoptCalendar]);

  const load = useCallback(async () => {
    if (document.visibilityState === 'hidden' || mutation.current || readController.current) return;
    const controller = new AbortController(); readController.current = controller;
    const sequence = ++readSequence.current;
    const current = () => mounted.current && selection.current === bookingsDate && sequence === readSequence.current && !controller.signal.aborted;
    setLoading(true);
    try {
      const data = await request<DriverDashboard>(`/driver/dashboard?${new URLSearchParams({ date: bookingsDate })}`, { signal: controller.signal });
      if (!current()) return;
      if (data.driver.id !== session.driver.id) { onExpired(); return; }
      setIdentity(data.driver);
      if (adoptCalendar(data)) { setDays(data.days); return; }
      if (data.date !== bookingsDate) throw new Error('არჩეული დღის ჯავშნები ვერ განახლდა. სცადეთ ხელახლა.');
      setRecord(data); setDays(data.days); setReadError('');
    } catch (cause) {
      if (!current()) return;
      if (unauthorized(cause)) { onExpired(); return; }
      setReadError(message(cause));
      // The server owns the Georgian calendar window, including midnight changes.
      if (cause instanceof ApiError && cause.status === 400) await refreshCalendar();
    } finally {
      if (current()) setLoading(false);
      if (readController.current === controller) readController.current = null;
    }
  }, [bookingsDate, session.driver.id, onExpired, adoptCalendar, refreshCalendar]);
  useEffect(() => {
    void load();
    const refreshVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener('focus', refreshVisible); document.addEventListener('visibilitychange', refreshVisible);
    return () => { readSequence.current++; readController.current?.abort(); readController.current = null; window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [load, retry]);

  async function setWorking(working: boolean) {
    if (mutation.current || !dayStatus || dayStatus.working === working || loggingOut) return;
    mutation.current = true;
    const date = attendanceDate;
    readSequence.current++; readController.current?.abort(); readController.current = null;
    setSavingDate(date); setFeedback(null);
    try {
      const result = await request<Calendar & { days: DriverDayStatus[] }>('/driver/attendance', { method: 'PATCH', body: JSON.stringify({ date, working }) });
      if (!mounted.current) return;
      adoptCalendar(result); setDays(result.days);
      setFeedback({ date, kind: 'success', message: 'თქვენი არჩევანი შენახულია.' });
    } catch (cause) {
      if (!mounted.current) return;
      if (unauthorized(cause)) { onExpired(); return; }
      setFeedback({ date, kind: 'error', message: message(cause) });
      if (cause instanceof ApiError && cause.status === 400) await refreshCalendar();
    } finally {
      mutation.current = false;
      if (mounted.current) { setSavingDate(null); setRetry(value => value + 1); }
    }
  }
  async function logout() {
    if (loggingOut || mutation.current) return;
    setLoggingOut(true); setLogoutError('');
    try { await onLogout(); }
    catch (cause) { if (mounted.current) { setLogoutError(message(cause)); setLoggingOut(false); } }
  }

  return <main className="driver-portal driver-home" data-driver-portal><header className="driver-page-header"><DriverBrand /><button type="button" className="driver-button driver-logout" onClick={() => void logout()} disabled={loggingOut || savingDate !== null}><LogOut size={23} />გამოსვლა</button></header><div className="driver-welcome"><span className="driver-welcome-icon"><CarFront size={31} /></span><div><h1>მძღოლის გვერდი</h1><p data-driver-name>{identity.name}</p></div></div>
    {logoutError && <p className="driver-feedback error" role="alert">{logoutError}</p>}
    <section className="driver-section driver-attendance" aria-label="სამუშაო დღე" data-driver-attendance data-date={attendanceDate} aria-busy={savingDate !== null}><DayButtons calendar={calendar} value={selectedDay} onChange={day => { setSelectedDay(day); setHourSelection(null); setFeedback(null); }} label="დღეები" disabled={savingDate !== null || loggingOut} /><div className="driver-section-heading driver-work-question"><h2>იმუშავებთ?</h2></div>
      {!dayStatus ? <p className="driver-loading-status" role="status"><LoaderCircle size={24} className="driver-spin" />მონაწილეობა იტვირთება…</p> : <><div className="driver-attendance-buttons" role="group" aria-label="მონაწილეობა"><button type="button" className="driver-working" aria-pressed={dayStatus.working} disabled={savingDate !== null || loggingOut} onClick={() => void setWorking(true)}><CheckCircle2 size={28} /><span>ვმუშაობ</span></button><button type="button" className="driver-not-working" aria-pressed={!dayStatus.working} disabled={savingDate !== null || loggingOut} onClick={() => void setWorking(false)}><X size={29} /><span>არ ვმუშაობ</span></button></div><p className="driver-attendance-current" role="status">{savingDate ? 'ინახება…' : dayStatus.working ? 'ამ დღეს მუშაობთ.' : 'ამ დღეს არ მუშაობთ.'}</p></>}
      {feedback?.date === attendanceDate && <p className={`driver-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'error' ? <X size={23} /> : <CheckCircle2 size={23} />}<span>{feedback.message}</span></p>}
      {!dayStatus && readError && <div className="driver-feedback error" role="alert"><span>{readError}</span><button type="button" className="driver-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={21} />ხელახლა ცდა</button></div>}
    </section>
    <section className="driver-section driver-bookings" aria-label="ჩემი ჯავშნები" data-driver-bookings data-date={bookingsDate}>
      {loading && !visible && <p className="driver-loading-status" role="status"><LoaderCircle size={24} className="driver-spin" />ჯავშნები იტვირთება…</p>}
      {readError && <div className="driver-feedback error" role="alert"><span>{readError}</span><button type="button" className="driver-button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={21} />ხელახლა ცდა</button></div>}
      {visible && <><div className="driver-section-heading driver-time-heading"><Clock3 size={25} /><h2>რეისის დრო</h2></div>{availableTimes.length ? <div className="driver-time-buttons" role="group" aria-label="რეისის დრო">{availableTimes.map(time => <button type="button" key={time} aria-pressed={selectedTime === time} disabled={loggingOut} onClick={() => setHourSelection({ date: selectedDate, time })}>{time}</button>)}</div> : <p className="driver-no-trips">რეისები ჯერ არ არის.</p>}{selectedTrip && !selectedTrip.active && <p className="driver-trip-status" role="status">არჩეული რეისის დრო გამორთულია.</p>}
        <div className="driver-section-heading driver-orders-heading"><CarFront size={26} /><h2>ჩემი შეკვეთები</h2><span className="driver-booking-count" aria-label={`შეკვეთები: ${selectedGroups.length}`} data-driver-booking-count>{selectedGroups.length}</span><button type="button" className="driver-refresh" aria-label="ჯავშნების განახლება" onClick={() => setRetry(value => value + 1)} disabled={loading || loggingOut}><RefreshCw size={24} /></button></div><div className="driver-seat-summary" role="status"><UsersRound size={21} /><span>დაჯავშნილი ადგილები</span><strong data-driver-seat-count>{reservedSeats}</strong></div>{selectedBookings.length ? <div className="driver-booking-list">{selectedGroups.map(group => group.grouped ? <TravelGroupCard key={group.key} group={group} capacity={identity.capacity} /> : <BookingCard key={group.key} booking={group.bookings[0]} />)}</div> : <div className="driver-empty"><CarFront size={32} /><p>ჯავშნები ჯერ არ არის.</p></div>}</>}
    </section><footer className="driver-page-footer">GreenTaxi · გორი ↔ თბილისი</footer>
  </main>;
}

function DayButtons({ calendar, value, onChange, label, disabled }: { calendar: Calendar; value: 0 | 1; onChange: (day: 0 | 1) => void; label: string; disabled: boolean }) {
  return <div className="driver-day-buttons" role="group" aria-label={label}>{([0, 1] as const).map(day => <button type="button" key={day} aria-label={day === 0 ? 'დღეს' : 'ხვალ'} aria-pressed={value === day} disabled={disabled} onClick={() => { if (day !== value) onChange(day); }}><strong>{day === 0 ? 'დღეს' : 'ხვალ'}</strong><span aria-hidden="true">{dateLabel(day === 0 ? calendar.today : calendar.tomorrow).slice(0, 5)}</span></button>)}</div>;
}

function TravelGroupCard({ group, capacity }: { group: TravelBookingGroup<DriverBooking>; capacity: number }) {
  const seats = group.bookings.reduce((total, booking) => total + (booking.bookingType === 'parcel' ? 0 : booking.seats), 0);
  return <section className="driver-travel-group" role="group" aria-label={`ერთ მანქანაში · ${seats} ადგილი`} data-driver-travel-group>
    <header className="driver-travel-group-heading"><CarFront size={24} /><strong>ერთ მანქანაში</strong><span><strong data-driver-group-seat-count>{seats}</strong> ადგილი</span></header>
    <p className="driver-travel-group-route">{directions[group.bookings[0].direction]}</p>
    {seats > capacity && <p className="driver-travel-group-warning" role="status" data-driver-group-capacity-warning>ჯგუფისთვის საკმარისი ადგილები არ არის — დაუკავშირდით ოპერატორს.</p>}
    <div className="driver-travel-group-pickups">{group.bookings.map((booking, index) => <BookingCard key={booking.id} booking={booking} pickupNumber={index + 1} />)}</div>
  </section>;
}

function BookingCard({ booking, pickupNumber }: { booking: DriverBooking; pickupNumber?: number }) {
  const preference = booking.seatPreference ? { front: 'წინ', middle: 'შუაში', back: 'უკან' }[booking.seatPreference] : null;
  const pickup = booking.direction === 'gori-tbilisi' ? booking.goriAddress : booking.pickupStopName || booking.didubeName;
  const normalizedCaller = booking.callerPhone ? normalizePhone(booking.callerPhone) : null;
  const caller = normalizedCaller && normalizedCaller !== normalizePhone(booking.phone) ? normalizedCaller : null;
  const hasBadges = booking.bookingType !== 'passenger' || booking.luggage || booking.dog || preference;
  return <article className="driver-booking-card" data-driver-booking={booking.id}>
    <header><strong>{pickupNumber ? `აყვანა ${pickupNumber}` : directions[booking.direction]}</strong></header>
    {booking.name?.trim() && <h3>{booking.name}</h3>}
    <div className="driver-booking-address"><MapPin size={24} /><div>{!pickupNumber && <span>აყვანა</span>}<strong>{pickup || '—'}</strong></div></div>
    <div className="driver-booking-meta"><span className="driver-booking-seats" data-driver-booking-seats>{booking.bookingType === 'parcel' ? <Package size={19} /> : booking.bookingType === 'whole_car' ? <CarFront size={19} /> : <UsersRound size={19} />}{booking.bookingType === 'parcel' ? 0 : booking.seats} ადგილი</span>{caller && <span className="driver-booking-caller" data-driver-caller><span>ზარი:</span><strong>{formatPhone(caller)}</strong></span>}</div>
    {hasBadges && <div className="driver-booking-badges">{booking.bookingType === 'parcel' && <span><Package size={19} />გზავნილი · ადგილების გარეშე</span>}{booking.bookingType === 'whole_car' && <span><CarFront size={19} />მთლიანი მანქანა</span>}{booking.luggage && <span><Luggage size={19} />ბარგი</span>}{booking.dog && <span><Dog size={19} />ძაღლი</span>}{preference && <span>ადგილი: {preference}</span>}</div>}
    <a className="driver-booking-phone" href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`}><Phone size={25} />{formatPhone(booking.phone)}</a>
  </article>;
}
