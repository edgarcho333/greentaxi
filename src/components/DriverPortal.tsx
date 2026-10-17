import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, CarFront, Check, CheckCircle2, Clock3, Dog, Leaf, LoaderCircle, LockKeyhole, LogOut, Luggage, MapPin, Package, Phone, RefreshCw, UserRound, UsersRound, X } from 'lucide-react';
import { ApiError, directions, request, type DriverBooking, type DriverDashboard, type DriverDayStatus, type DriverIdentity, type DriverSession } from '../api';
import { formatPhone, phoneDialNumber } from '../../shared/phone';
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
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const session = await request<DriverSession>('/driver/auth/login', { method: 'POST', body: JSON.stringify({ login: login.trim(), password }) });
      if (!session.driver) throw new Error('შესვლა ვერ მოხერხდა. გადაამოწმეთ სახელი და პაროლი.');
      if (mounted.current) onLogin(session);
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  return <main className="driver-portal driver-login-page"><DriverBrand /><section className="driver-login-card" aria-labelledby="driver-login-title"><span className="driver-login-icon"><CarFront size={34} /></span><h1 id="driver-login-title">მძღოლის შესვლა</h1><p>შედით თქვენი მომხმარებლის სახელით და პაროლით.</p>{notice && <p className="driver-feedback" role="status">{notice}</p>}<form onSubmit={submit} aria-busy={busy}>
    <label>მომხმარებლის სახელი<span className="driver-login-input"><UserRound size={23} /><input aria-label="მომხმარებლის სახელი" value={login} onChange={event => setLogin(event.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={80} required disabled={busy} /></span></label>
    <label>პაროლი<span className="driver-login-input"><LockKeyhole size={23} /><input aria-label="პაროლი" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy} /></span></label>
    {error && <p className="driver-feedback error" role="alert">{error}</p>}
    <button type="submit" className="driver-button primary driver-login-submit" disabled={busy}>{busy ? <LoaderCircle size={24} className="driver-spin" /> : <ArrowRight size={24} />}შესვლა</button>
  </form></section><a className="driver-back-link" href="/"><ArrowLeft size={22} />მთავარ გვერდზე დაბრუნება</a></main>;
}

function DriverHome({ session, onExpired, onLogout }: { session: DriverSession & { driver: DriverIdentity }; onExpired: () => void; onLogout: () => Promise<void> }) {
  const [identity, setIdentity] = useState(session.driver);
  const [calendar, setCalendar] = useState<Calendar>({ today: session.today, tomorrow: session.tomorrow });
  const [attendanceDay, setAttendanceDay] = useState<0 | 1>(0);
  const [bookingsDay, setBookingsDay] = useState<0 | 1>(0);
  const [days, setDays] = useState<DriverDayStatus[]>([]);
  const [record, setRecord] = useState<DriverDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [savingDate, setSavingDate] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const attendanceDate = attendanceDay === 0 ? calendar.today : calendar.tomorrow;
  const bookingsDate = bookingsDay === 0 ? calendar.today : calendar.tomorrow;
  const visible = record?.date === bookingsDate && record.today === calendar.today && record.tomorrow === calendar.tomorrow ? record : null;
  const dayStatus = days.find(day => day.date === attendanceDate);
  const calendarRef = useRef(calendar); calendarRef.current = calendar;
  const selection = useRef(bookingsDate); selection.current = bookingsDate;
  const mounted = useRef(false);
  const mutation = useRef(false);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const sessionController = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readSequence.current++; readController.current?.abort(); sessionController.current?.abort(); }; }, []);

  const adoptCalendar = useCallback((next: Calendar) => {
    const changed = calendarRef.current.today !== next.today || calendarRef.current.tomorrow !== next.tomorrow;
    if (changed) {
      calendarRef.current = next; setCalendar(next); setRecord(null); setDays([]); setFeedback(null);
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
    <section className="driver-section driver-attendance" aria-label="სამუშაო დღე" data-driver-attendance data-date={attendanceDate} aria-busy={savingDate !== null}><div className="driver-section-heading"><CalendarDays size={27} /><h2>სამუშაო დღე</h2></div><DayButtons calendar={calendar} value={attendanceDay} onChange={day => { setAttendanceDay(day); setFeedback(null); }} label="სამუშაო დღეები" disabled={savingDate !== null || loggingOut} /><p className="driver-selected-date">{dateLabel(attendanceDate)}</p>
      {!dayStatus ? <p className="driver-loading-status" role="status"><LoaderCircle size={24} className="driver-spin" />მონაწილეობა იტვირთება…</p> : <><div className="driver-attendance-buttons" role="group" aria-label="მონაწილეობა"><button type="button" className="driver-working" aria-pressed={dayStatus.working} disabled={savingDate !== null || loggingOut} onClick={() => void setWorking(true)}><CheckCircle2 size={28} /><span>ვმუშაობ</span>{dayStatus.working && <Check size={23} className="driver-selected-check" />}</button><button type="button" className="driver-not-working" aria-pressed={!dayStatus.working} disabled={savingDate !== null || loggingOut} onClick={() => void setWorking(false)}><X size={29} /><span>არ ვმუშაობ</span>{!dayStatus.working && <Check size={23} className="driver-selected-check" />}</button></div><p className="driver-attendance-current" role="status">{savingDate ? 'ინახება…' : dayStatus.working ? 'ამ დღეს მუშაობთ.' : 'ამ დღეს არ მუშაობთ.'}</p></>}
      {feedback?.date === attendanceDate && <p className={`driver-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.kind === 'error' ? <X size={23} /> : <CheckCircle2 size={23} />}<span>{feedback.message}</span></p>}
      {!dayStatus && readError && <div className="driver-feedback error" role="alert"><span>{readError}</span><button type="button" className="driver-button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={21} />ხელახლა ცდა</button></div>}
    </section>
    <section className="driver-section driver-bookings" aria-label="ჩემი ჯავშნები" data-driver-bookings data-date={bookingsDate}><div className="driver-section-heading"><CarFront size={27} /><h2>ჩემი ჯავშნები</h2><button type="button" className="driver-refresh" aria-label="ჯავშნების განახლება" onClick={() => setRetry(value => value + 1)} disabled={loading || loggingOut}><RefreshCw size={24} /></button></div><DayButtons calendar={calendar} value={bookingsDay} onChange={setBookingsDay} label="ჯავშნების დღეები" disabled={loggingOut} /><p className="driver-selected-date">{dateLabel(bookingsDate)}</p>
      {loading && !visible && <p className="driver-loading-status" role="status"><LoaderCircle size={24} className="driver-spin" />ჯავშნები იტვირთება…</p>}
      {readError && <div className="driver-feedback error" role="alert"><span>{readError}</span><button type="button" className="driver-button" onClick={() => setRetry(value => value + 1)} disabled={loading}><RefreshCw size={21} />ხელახლა ცდა</button></div>}
      {visible && <>{visible.trip && <div className="driver-trip-summary"><Clock3 size={25} /><strong>{visible.trip.time}</strong><span>{directions[visible.trip.direction]}</span>{!visible.trip.active && <small>დრო გამორთულია</small>}</div>}<p className="driver-booking-count">{visible.bookingScope === 'trip' ? 'თქვენი რეისის ჯავშნები' : 'თქვენი მთლიანი მანქანის ჯავშნები'} · {visible.bookings.length}</p>{visible.bookings.length ? <div className="driver-booking-list">{visible.bookings.map(booking => <BookingCard key={booking.id} booking={booking} />)}</div> : <div className="driver-empty"><CarFront size={32} /><p>{visible.bookingScope === 'trip' ? 'ამ დღისთვის ჯავშნები ჯერ არ არის.' : 'ამ დღისთვის მთლიანი მანქანის ჯავშნები ჯერ არ არის.'}</p></div>}</>}
    </section><footer className="driver-page-footer">GreenTaxi · გორი ↔ თბილისი</footer>
  </main>;
}

function DayButtons({ calendar, value, onChange, label, disabled }: { calendar: Calendar; value: 0 | 1; onChange: (day: 0 | 1) => void; label: string; disabled: boolean }) {
  return <div className="driver-day-buttons" role="group" aria-label={label}>{([0, 1] as const).map(day => <button type="button" key={day} aria-label={day === 0 ? 'დღეს' : 'ხვალ'} aria-pressed={value === day} disabled={disabled} onClick={() => onChange(day)}><strong>{day === 0 ? 'დღეს' : 'ხვალ'}</strong><span aria-hidden="true">{dateLabel(day === 0 ? calendar.today : calendar.tomorrow)}</span></button>)}</div>;
}

function BookingCard({ booking }: { booking: DriverBooking }) {
  const preference = booking.seatPreference ? { front: 'წინ', middle: 'შუაში', back: 'უკან' }[booking.seatPreference] : null;
  const pickup = booking.direction === 'gori-tbilisi' ? booking.goriAddress : booking.pickupStopName || booking.didubeName;
  const destination = booking.direction === 'gori-tbilisi' ? [booking.didubeName, booking.didubeAddress].filter(Boolean).join(' · ') : booking.goriAddress;
  return <article className="driver-booking-card" data-driver-booking={booking.id}><header><span className="driver-booking-time"><Clock3 size={23} />{booking.time}</span><span>{directions[booking.direction]}</span></header><h3>{booking.name?.trim() || 'მგზავრი'}</h3><a className="driver-booking-phone" href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`}><Phone size={25} />{formatPhone(booking.phone)}</a><div className="driver-booking-address"><MapPin size={24} /><div><span>აყვანა</span><strong>{pickup || '—'}</strong></div></div><div className="driver-booking-address"><MapPin size={24} /><div><span>ჩამოსვლა</span><strong>{destination || '—'}</strong></div></div><div className="driver-booking-badges"><span>{booking.bookingType === 'parcel' ? <Package size={21} /> : booking.bookingType === 'whole_car' ? <CarFront size={21} /> : <UsersRound size={21} />}{booking.bookingType === 'parcel' ? 'გზავნილი · ადგილების გარეშე' : booking.bookingType === 'whole_car' ? `მთლიანი მანქანა · ${booking.seats} ადგილი` : `${booking.seats} ადგილი`}</span>{booking.luggage && <span><Luggage size={21} />ბარგი</span>}{booking.dog && <span><Dog size={21} />ძაღლი</span>}{preference && <span>ადგილი: {preference}</span>}</div></article>;
}
