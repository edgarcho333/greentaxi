import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRightLeft, BarChart3, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Edit3, History, Inbox, Leaf, Loader2, LogOut, MapPin, Menu, MoreHorizontal, Phone, Plus, Printer, RefreshCw, Search, Settings, Trash2, Users, X } from 'lucide-react';
import { ApiError, addDays, directions, request, today, type Analytics, type Booking, type CallInquiry, type Direction, type Passenger, type PublicConfig, type Schedule, type User } from '../api';
import AdminSettings from './admin/AdminSettings';
import CallQueue from './admin/CallQueue';
import BookingPrint from './admin/BookingPrint';
import usePassengerProfile, { canonicalPassengerPhone } from './admin/usePassengerProfile';
import sidebarNight from '../assets/sidebar-night.webp';
import { formatPhone, normalizePhone, phoneDialNumber } from '../../shared/phone';
import './admin.css';
import './admin-reference.css';
import './admin-booking-form.css';

type View = 'scheduled' | 'incoming' | 'passengers' | 'analytics' | 'settings' | 'history';
type Modal = { kind: 'create'; inquiry?: CallInquiry } | { kind: 'edit' | 'confirm' | 'move' | 'delete' | 'restore'; booking: Booking };
type BookingFields = { phone: string; seats: number; direction: Direction; requestedDate: string; requestedTime: string; goriAddress: string; pickupStopId: number | null };
const titles: Record<View, string> = { scheduled: 'ჯავშნები', incoming: 'შემოსული განაცხადები', passengers: 'მგზავრები', analytics: 'ანალიტიკა', settings: 'პარამეტრები', history: 'წაშლილი ჯავშნების ისტორია' };
const nav: { view: View; label: string; icon: typeof CalendarDays }[] = [
  { view: 'scheduled', label: 'ჯავშნები', icon: CalendarDays },
  { view: 'incoming', label: 'შემოსული', icon: Inbox },
  { view: 'passengers', label: 'მგზავრები', icon: Users },
  { view: 'analytics', label: 'ანალიტიკა', icon: BarChart3 },
  { view: 'settings', label: 'პარამეტრები', icon: Settings },
  { view: 'history', label: 'ისტორია', icon: History },
];
const georgianMonths = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
function dateLabel(date: string, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' }) { const [year, month, day] = date.split('-'); if (options.month === 'long') return `${Number(day)} ${georgianMonths[Number(month) - 1]}${options.year ? ` ${year}` : ''}`; return `${day}/${month}${options.year ? `/${year}` : ''}`; }
function query(values: Record<string, string | undefined>) { const params = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); }); return params.toString(); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.'; }
function statusLabel(booking: Booking) { return booking.status === 'confirmed' ? 'დადასტურებული' : 'ელოდება დადასტურებას'; }
function bookingIdentity(booking: Booking) { return booking.name?.trim() || `#${String(booking.id).padStart(4, '0')}`; }
function bookingActionIdentity(booking: Booking) { return booking.name?.trim() || formatPhone(booking.phone) || bookingIdentity(booking); }

export default function AdminDashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [view, setView] = useState<View>('scheduled');
  const [direction, setDirection] = useState<Direction>('gori-tbilisi');
  const [date, setDate] = useState(today);
  const [dateStart, setDateStart] = useState(today);
  const [time, setTime] = useState('');
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [incomingCount, setIncomingCount] = useState(0);
  const [config, setConfig] = useState<PublicConfig>({ stops: [], didubeName: 'დიდუბე', didubeAddress: '' });
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [modal, setModal] = useState<Modal | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const listSequence = useRef(0);
  const timeStrip = useRef<HTMLDivElement>(null);
  const referenceView = view === 'scheduled' || view === 'incoming' || view === 'history';
  const dates = Array.from({ length: 8 }, (_, index) => addDays(dateStart, index));
  const selectedSchedule = schedules.find(item => item.date === date);
  const reload = useCallback(() => setRefresh(value => value + 1), []);

  useEffect(() => { const timer = window.setTimeout(() => setSearchQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { setPage(1); setMenuId(null); }, [view, date, time, direction, searchQuery, pageSize]);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const load = () => {
      if (document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true; controller = new AbortController();
      const signal = controller.signal;
      return Promise.allSettled([request<{ bookings: Booking[] }>('/admin/bookings?scope=incoming', { signal }), request<PublicConfig>('/public/config', { signal }), request<{ calls: CallInquiry[] }>('/admin/calls?scope=incoming', { signal })]).then(results => {
        if (!active || signal.aborted) return;
        if (results[0].status === 'fulfilled' && results[2].status === 'fulfilled') setIncomingCount(results[0].value.bookings.length + results[2].value.calls.length);
        if (results[1].status === 'fulfilled') setConfig(results[1].value);
      }).finally(() => { inFlight = false; });
    };
    void load();
    const refreshVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(refreshVisible, 5_000);
    window.addEventListener('focus', refreshVisible); document.addEventListener('visibilitychange', refreshVisible);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [refresh]);
  useEffect(() => {
    if (view !== 'scheduled') return;
    let active = true;
    setScheduleError(''); setSchedules([]);
    Promise.all(Array.from({ length: 8 }, (_, index) => request<Schedule>(`/admin/schedule?${query({ direction, date: addDays(dateStart, index) })}`))).then(result => { if (active) setSchedules(result); }).catch(cause => { if (active) setScheduleError(errorMessage(cause)); });
    return () => { active = false; };
  }, [direction, dateStart, view, refresh]);
  useEffect(() => {
    const sequence = ++listSequence.current;
    if (view === 'settings' || view === 'analytics') { setLoading(false); setError(''); return; }
    setLoading(true); setError(''); setMenuId(null);
    const load = view === 'passengers'
      ? request<{ passengers: Passenger[] }>(`/admin/passengers?${query({ search: searchQuery })}`).then(result => { if (sequence === listSequence.current) setPassengers(result.passengers); })
      : request<{ bookings: Booking[] }>(`/admin/bookings?${query({ scope: view === 'history' ? 'deleted' : view, direction, date: view === 'scheduled' ? date : undefined, time: view === 'scheduled' ? time : undefined, search: searchQuery })}`).then(result => { if (sequence === listSequence.current) setBookings(result.bookings); });
    load.catch(cause => { if (sequence === listSequence.current) setError(errorMessage(cause)); }).finally(() => { if (sequence === listSequence.current) setLoading(false); });
  }, [view, direction, date, time, searchQuery, refresh]);

  function changeView(next: View) { setView(next); setMobileNav(false); setSearch(''); setSearchQuery(''); setMenuId(null); }
  function chooseDate(next: string) { setDate(next); setTime(''); if (next < dateStart || next > addDays(dateStart, 7)) setDateStart(next); }
  function shiftDates(offset: number) { const next = addDays(dateStart, offset); setDateStart(next); setDate(next); setTime(''); }
  function completed(message: string) { setModal(null); setToast(message); reload(); }
  const pageCount = Math.max(1, Math.ceil(bookings.length / pageSize));
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);
  const visibleBookings = bookings.slice((page - 1) * pageSize, page * pageSize);

  return <div className={`admin-shell ${referenceView ? 'admin-reference-view' : ''}`}>
    {mobileNav && <button className="admin-mobile-backdrop" onClick={() => setMobileNav(false)} aria-label="მენიუს დახურვა" />}
    <aside className={`admin-sidebar ${mobileNav ? 'is-open' : ''}`}>
      <a href="/" className="admin-brand" aria-label="Green Taxi მთავარი გვერდი"><span className="admin-brand-leaf admin-logo-leaves"><Leaf className="admin-logo-leaf-small" size={23} /><Leaf className="admin-logo-leaf-large" size={35} /></span><span><b>Green</b> Taxi</span><small>GOOD RIDES, A CLEANER TOMORROW.</small></a>
      <nav className="admin-navigation" aria-label="ადმინისტრატორის ნავიგაცია">{nav.map(({ view: item, label, icon: Icon }) => <button key={item} className={`admin-nav-button ${view === item ? 'active' : ''}`} aria-label={label} onClick={() => changeView(item)}><Icon size={21} /><span>{label}</span>{item === 'incoming' && incomingCount > 0 && <span className="admin-nav-count" aria-hidden="true">{incomingCount}</span>}</button>)}</nav>
      <div className="admin-sidebar-bottom"><button onClick={onLogout} className="admin-logout"><LogOut size={30} /> გასვლა</button></div>
      <div className="admin-sidebar-visual"><img src={sidebarNight} alt="" /><div className="admin-sidebar-caption"><p>კომფორტული მგზავრობა<br />ყოველი მიმართულებით.</p><div className="admin-sidebar-progress"><span /><span /></div><div className="admin-sidebar-signature"><strong>Green Taxi</strong><small>მე შენი საიმედო მეგზური.</small></div><div className="admin-user admin-sidebar-user"><span className="admin-avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><small>ადმინისტრატორი</small></div></div></div></div>
    </aside>
    <main className="admin-main">
      {referenceView ? <h1 className="admin-sr-only">{titles[view]}</h1> : <header className="admin-page-header"><div className="admin-heading"><button className="admin-mobile-menu admin-icon-button" onClick={() => setMobileNav(true)} aria-label="მენიუს გახსნა"><Menu size={23} /></button><div><p className="admin-eyebrow">GREEN TAXI / მართვის პანელი</p><h1>{titles[view]}</h1></div></div><div className="admin-header-actions"><span className="admin-current-date"><CalendarDays size={16} /> {dateLabel(today(), { day: 'numeric', month: 'long' })}</span><button className="admin-primary" onClick={() => setModal({ kind: 'create' })}><Plus size={18} /><span>ახალი ჯავშანი</span></button></div></header>}
      {(view === 'scheduled' || view === 'incoming' || view === 'history') && <>
        <section className="admin-filters" aria-label="ჯავშნების ფილტრები">
          <button className="admin-mobile-menu admin-icon-button admin-toolbar-menu" onClick={() => setMobileNav(true)} aria-label="მენიუს გახსნა"><Menu size={23} /></button>
          <button className={`admin-incoming-button ${view === 'incoming' ? 'active' : ''}`} aria-label="შემოსული განაცხადები" onClick={() => changeView('incoming')}><span>შემოსული განაცხადები</span><b>{incomingCount}</b></button>
          <label className="admin-filter"><MapPin size={23} /><span><small>მიმართულება</small><select value={direction} onChange={event => { setDirection(event.target.value as Direction); setTime(''); }}>{Object.entries(directions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></span></label>
          <label className="admin-filter"><ClipboardList size={26} /><span><small>სტატუსი</small><select value={view} onChange={event => changeView(event.target.value as View)}><option value="scheduled">დადასტურებული</option><option value="incoming">ელოდება დადასტურებას</option><option value="history">წაშლილი</option></select></span></label>
          <div className="admin-filter admin-toolbar-actions"><div className="admin-toolbar-primary-actions"><button className="admin-toolbar-primary admin-toolbar-create" aria-label="ახალი ჯავშანი" onClick={() => setModal({ kind: 'create' })}><Plus size={22} /><span>ახალი ჯავშანი</span></button>{view === 'scheduled' && <button className="admin-toolbar-primary admin-toolbar-print" onClick={() => setPrintOpen(true)} aria-label="ჯავშნების ბეჭდვა" title="ჯავშნების ბეჭდვა"><Printer size={21} /><span>ბეჭდვა</span></button>}</div><button className="admin-icon-button admin-toolbar-refresh" onClick={reload} disabled={loading} aria-label="განახლება" title="განახლება"><RefreshCw size={16} /></button></div>
          <label className="admin-filter admin-search"><span><small className="admin-search-label"><Search size={19} />ძებნა</small><span className="admin-search-field"><Search size={18} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="სახელი ან ნომერი" aria-label="მგზავრის სახელი ან ტელეფონი" /></span></span></label>
        </section>
        {view === 'scheduled' && <>
          <section className="admin-date-panel" aria-label="თარიღის არჩევა"><div className="admin-strip-heading"><CalendarDays size={25} /><span>აირჩიეთ<br />თარიღი</span></div><button className="admin-icon-button admin-date-arrow" onClick={() => shiftDates(-8)} aria-label="წინა კვირა"><ChevronLeft size={20} /></button><div className="admin-date-strip">{dates.map(item => { const count = schedules.find(schedule => schedule.date === item)?.slots.reduce((sum, slot) => sum + slot.bookingCount, 0); return <button key={item} onClick={() => chooseDate(item)} className={`admin-date-chip ${date === item ? 'selected' : ''}`}><strong>{dateLabel(item)}</strong><span>{count === undefined ? '—' : count} ჯავშანი</span></button>; })}</div><button className="admin-icon-button admin-date-arrow" onClick={() => shiftDates(8)} aria-label="შემდეგი კვირა"><ChevronRight size={20} /></button><label className="admin-date-picker"><CalendarDays size={19} /><input type="date" value={date} onChange={event => event.target.value && chooseDate(event.target.value)} aria-label="აირჩიეთ სხვა თარიღი" /></label></section>
          <section className="admin-time-panel" aria-label="დროის არჩევა"><div className="admin-strip-heading"><Clock3 size={26} /><span>აირჩიეთ<br />დრო</span></div><div className="admin-time-strip" ref={timeStrip}><button className={`admin-time-chip admin-time-all ${!time ? 'selected' : ''}`} onClick={() => setTime('')}><strong>ყველა</strong><span>{selectedSchedule?.slots.reduce((sum, slot) => sum + slot.bookingCount, 0) ?? '—'}</span></button>{selectedSchedule?.slots.map(slot => <button key={slot.time} className={`admin-time-chip ${time === slot.time ? 'selected' : ''} ${!slot.active ? 'is-disabled-slot' : ''}`} onClick={() => setTime(slot.time)} title={slot.active ? `${slot.bookingCount} ჯავშანი · ${slot.seatCount} ადგილი` : 'დრო გამორთულია. არსებული ჯავშნები შენარჩუნებულია.'}><strong>{slot.time}</strong><span>{slot.bookingCount}</span>{!slot.active && <span className="admin-slot-dot" />}</button>)}</div><button className="admin-icon-button admin-time-arrow" onClick={() => timeStrip.current?.scrollBy({ left: Math.max(200, timeStrip.current.clientWidth * .7), behavior: 'smooth' })} aria-label="შემდეგი საათები"><ChevronRight size={22} /></button></section>
          {scheduleError && <div className="admin-error">{scheduleError} <button onClick={reload}>ხელახლა ცდა</button></div>}
          {selectedSchedule?.slots.some(slot => !slot.active && slot.bookingCount > 0) && <div className="admin-notice">გამორთულ დროზე ჯავშნები შენარჩუნებულია. გადაიტანეთ ისინი მოქმედ დროზე.</div>}
        </>}
        {view === 'incoming' && <div className="admin-section-note"><Inbox size={18} />აირჩიეთ თარიღი და დრო — სლოტში დამატება ჯავშანს ავტომატურად დაადასტურებს.</div>}
        {view === 'history' && <div className="admin-section-note"><History size={18} />წაშლილი ჯავშნები ინახება ისტორიაში. აღდგენისას შეგიძლიათ აირჩიოთ მოქმედი დრო.</div>}
        {(view === 'incoming' || view === 'history') && <CallQueue scope={view === 'incoming' ? 'incoming' : 'deleted'} search={searchQuery} refresh={refresh} onConvert={inquiry => setModal({ kind: 'create', inquiry })} onChange={reload} />}
        <section className="admin-table-card"><div className="admin-sr-only"><h2>{view === 'scheduled' ? `${dateLabel(date, { day: 'numeric', month: 'long', year: 'numeric' })}${time ? ` · ${time}` : ''}` : view === 'incoming' ? 'ახალი განაცხადები' : 'წაშლილი ჯავშნები'}</h2><span>{loading ? 'იტვირთება…' : `${bookings.length} ჯავშანი · ${bookings.reduce((sum, item) => sum + item.seats, 0)} ადგილი`}</span></div>
          {error ? <div className="admin-error">{error}<button onClick={reload}>ხელახლა ცდა</button></div> : loading ? <Loading /> : bookings.length === 0 ? <Empty icon={view === 'incoming' ? Inbox : view === 'history' ? History : CalendarDays} title={searchQuery ? 'ჯავშანი ვერ მოიძებნა' : view === 'incoming' ? 'საიტიდან განაცხადები ჯერ არ არის' : view === 'history' ? 'წაშლილი ჯავშნები არ არის' : 'ამ დროისთვის ჯავშნები არ არის'} text={searchQuery ? 'სცადეთ სხვა სახელი ან ტელეფონის ნომერი.' : view === 'scheduled' ? 'შექმენით ჯავშანი ან დაამატეთ განაცხადი შემოსულებიდან.' : view === 'incoming' ? 'მგზავრის მიერ გამოგზავნილი განაცხადები აქ გამოჩნდება.' : 'წაშლილი ჯავშნები აქ გამოჩნდება.'} /> : <><div className="admin-table-scroll"><table className="admin-booking-table"><thead><tr><th><span className="admin-time-column-heading">{view === 'scheduled' ? 'დრო' : 'თარიღი / დრო'}{view === 'scheduled' && <ChevronDown size={14} />}</span></th><th>მგზავრი</th><th>ტელეფონი</th><th>მიმართულება</th><th>აყვანის ადგილი</th><th>ჩამოსვლის ადგილი</th><th className="admin-center">ადგილები</th><th>სტატუსი</th><th className="admin-actions-heading">მოქმედება</th></tr></thead><tbody>{visibleBookings.map(booking => <tr key={booking.id} data-booking-id={booking.id}>
            <td>{view === 'scheduled' ? <button className="admin-row-time" aria-label={`${bookingActionIdentity(booking)}: დროის შეცვლა`} onClick={() => setModal({ kind: 'move', booking })}><strong className="admin-time-value">{booking.assignedTime || booking.requestedTime}</strong><ChevronDown size={14} /></button> : <><strong className="admin-time-value">{booking.assignedTime || booking.requestedTime}</strong><small className="admin-cell-subtitle">{dateLabel(booking.assignedDate || booking.requestedDate)}</small></>}</td><td><strong className="admin-passenger-name">{bookingIdentity(booking)}</strong>{view !== 'scheduled' && <small className="admin-cell-subtitle">#{String(booking.id).padStart(4, '0')}</small>}</td><td className="admin-phone-cell"><a href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`}>{formatPhone(booking.phone)}</a></td><td className="admin-direction-cell">{directions[booking.direction]}</td><td>{booking.direction === 'gori-tbilisi' ? booking.goriAddress : booking.pickupStopName || 'გაჩერება არ არის მითითებული'}</td><td>{booking.direction === 'gori-tbilisi' ? booking.didubeName : booking.goriAddress}</td><td className="admin-center"><span className="admin-seat-badge">{booking.seats}</span></td><td><span className={`admin-status ${booking.status === 'confirmed' ? 'confirmed' : 'waiting'}`}>{statusLabel(booking)}</span></td><td><div className="admin-row-actions">{view === 'incoming' ? <button className="admin-confirm-button" onClick={() => setModal({ kind: 'confirm', booking })}><Check size={15} /> დამატება</button> : view === 'history' ? <button className="admin-restore-button" onClick={() => setModal({ kind: 'restore', booking })}><History size={15} /> აღდგენა</button> : <a className="admin-icon-button" href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`} aria-label={`${bookingActionIdentity(booking)}: დარეკვა`}><Phone size={15} /></a>}{view !== 'history' && <><button className="admin-icon-button" onClick={() => setModal({ kind: 'edit', booking })} aria-label={`${bookingActionIdentity(booking)}: რედაქტირება`}><Edit3 size={15} /></button><div className="admin-more-wrap"><button className="admin-icon-button" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenuPosition({ top: Math.min(rect.bottom + 5, window.innerHeight - 140), left: Math.max(8, rect.right - 139) }); setMenuId(menuId === booking.id ? null : booking.id); }} aria-label={`${bookingActionIdentity(booking)}: სხვა მოქმედებები`} aria-expanded={menuId === booking.id}><MoreHorizontal size={19} /></button>{menuId === booking.id && <><button className="admin-menu-dismiss" onClick={() => setMenuId(null)} aria-label="მოქმედებების დახურვა" /><div className="admin-row-menu" style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, right: 'auto' }}>{view === 'scheduled' && <button onClick={() => { setModal({ kind: 'move', booking }); setMenuId(null); }}><ArrowRightLeft size={15} /> გადატანა</button>}<a href={`tel:${phoneDialNumber(booking.phone) || booking.phone}`}><Phone size={15} /> დარეკვა</a><button className="admin-danger-text" onClick={() => { setModal({ kind: 'delete', booking }); setMenuId(null); }}><Trash2 size={15} /> წაშლა</button></div></>}</div></>}</div></td>
          </tr>)}</tbody></table></div><div className="admin-pagination"><div className="admin-page-buttons"><button className="admin-icon-button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="წინა გვერდი"><ChevronLeft size={18} /></button>{Array.from({ length: Math.min(pageCount, 5) }, (_, index) => { const value = Math.max(1, Math.min(page - 2, pageCount - 4)) + index; return <button className={page === value ? 'selected' : ''} key={value} onClick={() => setPage(value)}>{value}</button>; })}<button className="admin-icon-button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="შემდეგი გვერდი"><ChevronRight size={18} /></button><span>{Math.min((page - 1) * pageSize + 1, bookings.length)}–{Math.min(page * pageSize, bookings.length)} / {bookings.length}</span></div><label>ჩანაწერები გვერდზე<select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}><option>15</option><option>30</option><option>50</option></select></label></div></>}
        </section>
      </>}
      {view === 'passengers' && <section className="admin-table-card"><div className="admin-table-heading"><div><h2>მგზავრების სია</h2><span>მგზავრები გაერთიანებულია ტელეფონის ნომრის მიხედვით</span></div><label className="admin-inline-search"><Search size={18} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="სახელი ან ტელეფონი" /></label></div>{error ? <div className="admin-error">{error}<button onClick={reload}>ხელახლა ცდა</button></div> : loading ? <Loading /> : passengers.length === 0 ? <Empty icon={Users} title="მგზავრი ვერ მოიძებნა" text="პირველი ჯავშნის შემდეგ მგზავრი ამ სიაში გამოჩნდება." /> : <div className="admin-table-scroll"><table className="admin-booking-table admin-passengers-table"><thead><tr><th>მგზავრი</th><th>ტელეფონი</th><th>ჯავშნები</th><th>ადგილები</th><th>ბოლო მგზავრობა</th><th>მოქმედება</th></tr></thead><tbody>{passengers.map(passenger => <tr key={passenger.phone}><td><strong>{passenger.name}</strong></td><td>{formatPhone(passenger.phone)}</td><td>{passenger.orderCount}</td><td>{passenger.seats}</td><td>{dateLabel(passenger.latestDate, { day: 'numeric', month: 'long', year: 'numeric' })}</td><td><a className="admin-icon-button" href={`tel:${phoneDialNumber(passenger.phone) || passenger.phone}`} aria-label={`${passenger.name}: დარეკვა`}><Phone size={16} /></a></td></tr>)}</tbody></table></div>}</section>}
      {view === 'analytics' && <AnalyticsPanel refresh={refresh} />}
      {view === 'settings' && <AdminSettings onChange={reload} />}
      <footer className="admin-footer"><span><span className="admin-live-dot" /> Green Taxi</span><span>გორი ↔ თბილისი</span></footer>
    </main>
    {printOpen && <BookingPrint date={date} direction={direction} time={time} onClose={() => setPrintOpen(false)} />}
    {modal && <BookingModal modal={modal} config={config} defaultDirection={direction} defaultDate={date} defaultTime={time} onClose={() => setModal(null)} onComplete={completed} />}
    {toast && <div className="admin-toast" role="status"><CheckCircle2 size={19} />{toast}<button onClick={() => setToast('')} aria-label="შეტყობინების დახურვა"><X size={16} /></button></div>}
  </div>;
}

function Loading() { return <div className="admin-loading" role="status"><Loader2 size={25} className="admin-spin" /><span>მონაცემები იტვირთება…</span></div>; }
function Empty({ icon: Icon, title, text }: { icon: typeof Inbox; title: string; text: string }) { return <div className="admin-empty"><span><Icon size={30} /></span><h3>{title}</h3><p>{text}</p></div>; }

function Dialog({ title, subtitle, children, onClose, className, busy = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; className?: string; busy?: boolean }) {
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; document.addEventListener('keydown', onKey); return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', onKey); }; }, [onClose]);
  return <div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className={`admin-dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title"><header><div><h2 id="admin-dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="admin-icon-button" disabled={busy} onClick={onClose} aria-label="დახურვა"><X size={21} /></button></header>{children}</section></div>;
}

function staffDateAllowed(date: string, anchor = today()) { return date >= anchor && date <= addDays(anchor, 2); }
function staffFutureTime(date: string, time: string, now = Date.now()) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && new Date(`${date}T${time}:00+04:00`).getTime() > now; }
function staffDefaultDate(date: string) { return staffDateAllowed(date) ? date : today(); }

function BookingModal({ modal, config, defaultDirection, defaultDate, defaultTime, onClose, onComplete }: { modal: Modal; config: PublicConfig; defaultDirection: Direction; defaultDate: string; defaultTime: string; onClose: () => void; onComplete: (message: string) => void }) {
  const booking = 'booking' in modal ? modal.booking : undefined;
  const inquiry = modal.kind === 'create' ? modal.inquiry : undefined;
  const inquiryPhone = inquiry?.phone ? canonicalPassengerPhone(inquiry.phone) : null;
  const savedProfile = inquiryPhone && inquiry?.passengerProfile && inquiryPhone === canonicalPassengerPhone(inquiry.passengerProfile.phone) ? inquiry.passengerProfile : null;
  const savedStop = savedProfile?.pickupStopId && config.stops.some(stop => stop.active && stop.id === savedProfile.pickupStopId) ? savedProfile.pickupStopId : null;
  const [fields, setFields] = useState<BookingFields>(() => {
    const originalDate = booking?.assignedDate || booking?.requestedDate || defaultDate;
    const date = modal.kind === 'edit' || modal.kind === 'delete' ? originalDate : staffDefaultDate(originalDate);
    const originalTime = booking?.assignedTime || booking?.requestedTime || defaultTime;
    return { phone: formatPhone(booking?.phone || inquiry?.phone || ''), seats: booking?.seats || 1, direction: booking?.direction || defaultDirection, requestedDate: date, requestedTime: date === originalDate && staffFutureTime(date, originalTime) ? originalTime : '', goriAddress: booking?.goriAddress || savedProfile?.goriAddress || '', pickupStopId: booking?.pickupStopId || savedStop };
  });
  const provenance = useRef<Record<'goriAddress' | 'pickupStopId', 'empty' | 'profile' | 'manual'>>({ goriAddress: savedProfile ? 'profile' : 'empty', pickupStopId: savedStop ? 'profile' : 'empty' });
  const profilePhone = useRef(canonicalPassengerPhone(fields.phone));
  const createAttempts = useRef(new Map<string, string>());
  const busyRef = useRef(false);
  const activeRef = useRef(true);
  const autoPick = useRef(modal.kind === 'create');
  const [clockNow, setClockNow] = useState(Date.now);
  const [scheduleRecord, setScheduleRecord] = useState<{ key: string; data: Schedule } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleRevision, setScheduleRevision] = useState(0);
  const [restoreMode, setRestoreMode] = useState<'checking' | 'original' | 'select'>(modal.kind === 'restore' && booking?.status === 'confirmed' ? 'checking' : 'original');
  const [originalAvailable, setOriginalAvailable] = useState(false);
  const [originalChecking, setOriginalChecking] = useState(modal.kind === 'restore' && booking?.status === 'confirmed');
  const [originalError, setOriginalError] = useState('');
  const [originalRevision, setOriginalRevision] = useState(0);
  const anchor = today();
  const days = [anchor, addDays(anchor, 1), addDays(anchor, 2)];
  const needsSchedule = modal.kind === 'create' || modal.kind === 'confirm' || modal.kind === 'move' || (modal.kind === 'restore' && restoreMode === 'select');
  const isDetails = modal.kind === 'create' || modal.kind === 'edit';
  const scheduleKey = `${fields.direction}:${fields.requestedDate}`;
  const schedule = scheduleRecord?.key === scheduleKey && scheduleRecord.data.direction === fields.direction && scheduleRecord.data.date === fields.requestedDate ? scheduleRecord.data : null;
  const activeTimes = schedule?.slots.filter(slot => slot.active && staffFutureTime(fields.requestedDate, slot.time, clockNow)).map(slot => slot.time) || [];
  const passengerProfile = usePassengerProfile(fields.phone, modal.kind === 'create' && !busy);
  const activeStops = config.stops.filter(stop => stop.active);

  useEffect(() => {
    activeRef.current = true;
    const updateClock = () => { if (document.visibilityState !== 'hidden') setClockNow(Date.now()); };
    const timer = window.setInterval(updateClock, 15_000);
    window.addEventListener('focus', updateClock); document.addEventListener('visibilitychange', updateClock);
    return () => { activeRef.current = false; window.clearInterval(timer); window.removeEventListener('focus', updateClock); document.removeEventListener('visibilitychange', updateClock); };
  }, []);
  useEffect(() => {
    if (!needsSchedule || busyRef.current) return;
    setFields(current => {
      if (!staffDateAllowed(current.requestedDate, anchor)) { autoPick.current = false; return { ...current, requestedDate: anchor, requestedTime: '' }; }
      if (current.requestedTime && !staffFutureTime(current.requestedDate, current.requestedTime, clockNow)) { autoPick.current = false; return { ...current, requestedTime: '' }; }
      return current;
    });
  }, [anchor, clockNow, needsSchedule]);
  useEffect(() => {
    const profile = passengerProfile.profile;
    const phone = canonicalPassengerPhone(fields.phone);
    if (!profile || !phone || modal.kind !== 'create' || busy || canonicalPassengerPhone(profile.phone) !== phone) return;
    const changes: Partial<BookingFields> = {};
    if (provenance.current.goriAddress !== 'manual') { changes.goriAddress = profile.goriAddress; provenance.current.goriAddress = 'profile'; }
    if (provenance.current.pickupStopId !== 'manual') {
      const activeStop = profile.pickupStopId !== null && activeStops.some(stop => stop.id === profile.pickupStopId);
      if (fields.direction === 'tbilisi-gori' && activeStop) { changes.pickupStopId = profile.pickupStopId; provenance.current.pickupStopId = 'profile'; }
      else if (!activeStop && (fields.direction === 'tbilisi-gori' || provenance.current.pickupStopId === 'profile')) { changes.pickupStopId = null; provenance.current.pickupStopId = 'empty'; }
    }
    setFields(current => {
      if (canonicalPassengerPhone(current.phone) !== phone) return current;
      const applicable = { ...changes };
      for (const key of ['goriAddress', 'pickupStopId'] as const) if (provenance.current[key] === 'manual') delete applicable[key];
      if (Object.entries(applicable).every(([key, value]) => current[key as keyof BookingFields] === value)) return current;
      return { ...current, ...applicable };
    });
  }, [passengerProfile.profile, fields.phone, fields.direction, config.stops, modal.kind, busy]);
  function update<K extends keyof BookingFields>(key: K, value: BookingFields[K]) {
    if (busyRef.current) return;
    const reset: Partial<BookingFields> = {};
    if (modal.kind === 'create') {
      if (key === 'goriAddress' || key === 'pickupStopId') provenance.current[key as keyof typeof provenance.current] = 'manual';
      if (key === 'phone') {
        const nextPhone = canonicalPassengerPhone(String(value));
        if (profilePhone.current !== nextPhone) {
          if (provenance.current.goriAddress === 'profile') { reset.goriAddress = ''; provenance.current.goriAddress = 'empty'; }
          if (provenance.current.pickupStopId === 'profile') { reset.pickupStopId = null; provenance.current.pickupStopId = 'empty'; }
        }
        profilePhone.current = nextPhone;
      }
    }
    if (key === 'direction' || key === 'requestedDate') { reset.requestedTime = ''; autoPick.current = modal.kind === 'create'; }
    if (key === 'requestedTime') autoPick.current = false;
    setFields(current => ({ ...current, ...reset, [key]: value }));
  }
  useEffect(() => {
    if (!needsSchedule || !staffDateAllowed(fields.requestedDate, anchor)) return;
    const controller = new AbortController();
    const key = scheduleKey;
    const shouldAutoPick = autoPick.current; autoPick.current = false;
    setScheduleLoading(true); setScheduleError(''); setScheduleRecord(null);
    request<Schedule>(`/admin/schedule?${query({ direction: fields.direction, date: fields.requestedDate })}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || result.direction !== fields.direction || result.date !== fields.requestedDate) return;
      setScheduleRecord({ key, data: result });
      setFields(current => {
        if (`${current.direction}:${current.requestedDate}` !== key) return current;
        const available = result.slots.filter(slot => slot.active && staffFutureTime(current.requestedDate, slot.time));
        const selected = available.some(slot => slot.time === current.requestedTime);
        return { ...current, requestedTime: selected ? current.requestedTime : shouldAutoPick ? available[0]?.time || '' : '' };
      });
    }).catch(cause => { if (!controller.signal.aborted) setScheduleError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setScheduleLoading(false); });
    return () => controller.abort();
  }, [fields.direction, fields.requestedDate, needsSchedule, scheduleRevision, anchor]);
  useEffect(() => {
    if (modal.kind !== 'restore' || booking?.status !== 'confirmed') return;
    const controller = new AbortController(); setOriginalChecking(true); setOriginalError('');
    request<Schedule>(`/admin/schedule?${query({ direction: booking.direction, date: booking.assignedDate || booking.requestedDate })}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const available = result.slots.some(slot => slot.active && slot.time === (booking.assignedTime || booking.requestedTime));
      setOriginalAvailable(available); setRestoreMode(available ? 'original' : 'select');
      if (!available) { autoPick.current = false; setFields(current => ({ ...current, requestedDate: staffDefaultDate(current.requestedDate), requestedTime: '' })); }
    }).catch(cause => { if (!controller.signal.aborted) setOriginalError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setOriginalChecking(false); });
    return () => controller.abort();
  }, [modal.kind, booking?.id, originalRevision]);

  function chooseRestoreTime() {
    if (busyRef.current || originalChecking) return;
    autoPick.current = false; setRestoreMode('select'); setError('');
    setFields(current => ({ ...current, requestedDate: staffDefaultDate(current.requestedDate), requestedTime: '' }));
  }
  const title = { create: 'ახალი ჯავშანი', edit: 'ჯავშნის რედაქტირება', confirm: 'განაცხადის დამატება', move: 'ჯავშნის გადატანა', delete: 'ჯავშნის წაშლა', restore: 'ჯავშნის აღდგენა' }[modal.kind];
  const actionLabel = { create: 'შექმნა და დადასტურება', edit: 'ცვლილებების შენახვა', confirm: 'დამატება და დადასტურება', move: 'გადატანა', delete: 'წაშლა', restore: 'აღდგენა' }[modal.kind];
  const scheduleValid = !!schedule && !scheduleLoading && !scheduleError && days.includes(fields.requestedDate) && activeTimes.includes(fields.requestedTime);
  const detailsValid = !isDetails || (!!normalizePhone(fields.phone) && Number.isInteger(fields.seats) && fields.seats >= 1 && fields.seats <= 8 && fields.goriAddress.trim().length >= 3 && fields.goriAddress.trim().length <= 500 && (fields.direction === 'gori-tbilisi' || activeStops.some(stop => stop.id === fields.pickupStopId) || (modal.kind === 'edit' && !!booking?.pickupStopId && fields.pickupStopId === booking.pickupStopId)));
  const restoreReady = modal.kind !== 'restore' || booking?.status === 'waiting' || (!originalChecking && (restoreMode === 'select' || (restoreMode === 'original' && originalAvailable)));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busyRef.current) return;
    const submittedPhone = normalizePhone(fields.phone);
    if (isDetails && !submittedPhone) { setError('მიუთითეთ სწორი ტელეფონის ნომერი.'); return; }
    if (isDetails && (!Number.isInteger(fields.seats) || fields.seats < 1 || fields.seats > 8)) { setError('აირჩიეთ 1-დან 8-მდე ადგილი.'); return; }
    if (!detailsValid || !restoreReady) { setError('შეავსეთ მგზავრობის მონაცემები.'); return; }
    if (needsSchedule && (!scheduleValid || !staffDateAllowed(fields.requestedDate) || !staffFutureTime(fields.requestedDate, fields.requestedTime))) {
      autoPick.current = false; setClockNow(Date.now()); setFields(current => ({ ...current, requestedDate: staffDefaultDate(current.requestedDate), requestedTime: '' }));
      setError('აირჩიეთ მომავალი მოქმედი დრო მომდევნო სამი დღიდან.'); return;
    }
    busyRef.current = true; setBusy(true); setError('');
    try {
      if (modal.kind === 'create') {
        const path = inquiry ? `/admin/calls/${inquiry.id}/convert` : '/admin/bookings';
        const body = JSON.stringify({ phone: submittedPhone, seats: fields.seats, direction: fields.direction, requestedDate: fields.requestedDate, requestedTime: fields.requestedTime, goriAddress: fields.goriAddress, pickupStopId: fields.direction === 'tbilisi-gori' ? fields.pickupStopId : null });
        const identity = `${path}:${body}`;
        let key = createAttempts.current.get(identity);
        if (!key) { key = crypto.randomUUID(); createAttempts.current.set(identity, key); }
        await request<Booking>(path, { method: 'POST', headers: { 'Idempotency-Key': key }, body });
      } else if (modal.kind === 'edit') await request<Booking>(`/admin/bookings/${modal.booking.id}`, { method: 'PATCH', body: JSON.stringify({ phone: submittedPhone, seats: fields.seats, goriAddress: fields.goriAddress, pickupStopId: fields.direction === 'tbilisi-gori' ? fields.pickupStopId : null }) });
      else await request<Booking>(`/admin/bookings/${modal.booking.id}/${modal.kind}`, { method: 'POST', body: JSON.stringify(modal.kind === 'delete' || (modal.kind === 'restore' && !needsSchedule) ? {} : { date: fields.requestedDate, time: fields.requestedTime }) });
      if (activeRef.current) onComplete({ create: 'ჯავშანი შეიქმნა და დადასტურდა', edit: 'ცვლილებები შენახულია', confirm: 'ჯავშანი დაემატა და დადასტურდა', move: 'ჯავშანი გადატანილია', delete: 'ჯავშანი გადატანილია ისტორიაში', restore: 'ჯავშანი აღდგენილია' }[modal.kind]);
    } catch (cause) {
      if (!activeRef.current) return;
      setError(errorMessage(cause));
      if (cause instanceof ApiError && ['SLOT_INACTIVE', 'SLOT_PAST', 'DATE_OUT_OF_RANGE'].includes(cause.code || '')) {
        autoPick.current = false; setClockNow(Date.now());
        setFields(current => ({ ...current, requestedDate: staffDefaultDate(current.requestedDate), requestedTime: '' }));
        if (modal.kind === 'restore' && !needsSchedule) { setOriginalAvailable(false); setRestoreMode('select'); }
        setScheduleRevision(value => value + 1);
      }
    } finally { busyRef.current = false; if (activeRef.current) setBusy(false); }
  }
  return <Dialog title={inquiry ? 'ზარის მიხედვით ჯავშნის შექმნა' : title} subtitle={booking ? `${booking.name?.trim() ? `${booking.name} · ` : ''}${formatPhone(booking.phone)} · #${String(booking.id).padStart(4, '0')}` : inquiry ? 'შეავსეთ მგზავრობის მონაცემები. ზარი დადასტურებულ ჯავშნად გადაიქცევა.' : 'ოპერატორის მიერ შექმნილი ჯავშანი მაშინვე დადასტურდება.'} className={modal.kind === 'delete' ? undefined : 'admin-operator-booking-dialog'} busy={busy} onClose={() => { if (!busyRef.current) onClose(); }}><form onSubmit={submit} className={`admin-booking-form${modal.kind === 'delete' ? '' : ' admin-operator-booking-form'}`}>
    {modal.kind === 'delete' ? <div className="admin-delete-body"><span><Trash2 size={27} /></span><p>ნამდვილად გსურთ ამ ჯავშნის წაშლა?</p><small>მონაცემები ისტორიაში შენარჩუნდება. ჯავშნის აღდგენა ნებისმიერ დროს შეგიძლიათ.</small></div> : <>
      {isDetails && <>
        <div className="admin-operator-location">
          {fields.direction === 'tbilisi-gori' && <label>აყვანის ადგილი თბილისში<select aria-label="აყვანის ადგილი თბილისში" required disabled={busy} value={fields.pickupStopId || ''} onChange={event => update('pickupStopId', Number(event.target.value))}><option value="" disabled>აირჩიეთ გაჩერება</option>{modal.kind === 'edit' && booking?.pickupStopId && !activeStops.some(stop => stop.id === booking.pickupStopId) && <option value={booking.pickupStopId}>{booking.pickupStopName} (გამორთული)</option>}{activeStops.map(stop => <option key={stop.id} value={stop.id}>{stop.name} — {stop.address}</option>)}</select>{!activeStops.length && !booking?.pickupStopId && <small className="admin-danger-text">ჯერ დაამატეთ მოქმედი გაჩერება პარამეტრებში.</small>}</label>}
          <label>{fields.direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'}<textarea autoFocus aria-label={fields.direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'} required disabled={busy} minLength={3} maxLength={500} rows={1} value={fields.goriAddress} onChange={event => update('goriAddress', event.target.value)} placeholder="ქუჩა, სახლის ნომერი, ორიენტირი" /></label>
        </div>
        <label>ტელეფონის ნომერი<input required disabled={busy} type="tel" inputMode="tel" autoComplete="tel-national" maxLength={30} value={fields.phone} onChange={event => update('phone', event.target.value)} onBlur={event => update('phone', formatPhone(event.target.value))} placeholder="მაგ. 555 12 34 56" /></label>
        {modal.kind === 'create' && passengerProfile.status === 'loading' && <p className="admin-form-hint admin-profile-feedback" role="status"><Loader2 size={15} className="admin-spin" />შენახული მისამართების ძიება…</p>}
        {modal.kind === 'create' && passengerProfile.status === 'found' && <p className="admin-form-hint admin-profile-feedback" role="status"><CheckCircle2 size={16} /><span>მისამართები ნაპოვნია. თქვენ მიერ შეცვლილი ან გასუფთავებული ველები შენარჩუნდება.</span></p>}
        {modal.kind === 'create' && passengerProfile.status === 'error' && <p className="admin-form-hint admin-profile-feedback admin-profile-error" role="status"><span>მისამართები ვერ ჩაიტვირთა. შეავსეთ ხელით.</span><button type="button" className="admin-text-button" disabled={busy} onClick={passengerProfile.retry}>ხელახლა ცდა</button></p>}
        <fieldset className="admin-operator-group" role="group" aria-label="მიმართულება"><legend>მიმართულება</legend><div className="admin-operator-directions">{Object.entries(directions).map(([value, label]) => <button type="button" key={value} disabled={busy || modal.kind === 'edit'} aria-pressed={fields.direction === value} onClick={() => update('direction', value as Direction)}>{label}</button>)}</div></fieldset>
        <fieldset className="admin-operator-group" role="group" aria-label="ადგილების რაოდენობა"><legend>ადგილების რაოდენობა</legend><div className="admin-operator-seats">{Array.from({ length: 8 }, (_, index) => index + 1).map(count => <button type="button" key={count} aria-label={`${count} ადგილი`} aria-pressed={fields.seats === count} disabled={busy} onClick={() => update('seats', count)}>{count}</button>)}</div></fieldset>
        {fields.direction === 'gori-tbilisi' && <div className="admin-operator-fixed-stop"><MapPin size={16} /><span>თბილისში: <strong>{booking?.didubeName || config.didubeName}</strong>{(booking?.didubeAddress || config.didubeAddress) && ` · ${booking?.didubeAddress || config.didubeAddress}`}</span></div>}
      </>}
      {!isDetails && <div className="admin-order-summary"><ArrowRightLeft size={18} /><strong>{directions[fields.direction]}</strong><span>{fields.seats} ადგილი</span></div>}
      {modal.kind === 'restore' && booking?.status === 'confirmed' && <div className="admin-operator-restore">
        {originalChecking ? <p role="status"><Loader2 size={16} className="admin-spin" />თავდაპირველი დრო მოწმდება…</p> : <>
          <div className="admin-operator-restore-options" role="group" aria-label="აღდგენის დრო"><button type="button" aria-label="თავდაპირველი დროის შენარჩუნება" aria-pressed={restoreMode === 'original'} disabled={busy || !originalAvailable} onClick={() => { setRestoreMode('original'); setError(''); }}>თავდაპირველი დრო</button><button type="button" aria-label="ახალი დროის არჩევა" aria-pressed={restoreMode === 'select'} disabled={busy} onClick={chooseRestoreTime}>ახალი დროის არჩევა</button></div>
          {restoreMode === 'original' && <p>ჯავშანი აღდგება უცვლელად: {dateLabel(booking.assignedDate || booking.requestedDate, { year: 'numeric' })} · {booking.assignedTime || booking.requestedTime}</p>}
          {!originalAvailable && !originalError && <p>თავდაპირველი დრო გამორთულია. აირჩიეთ ახალი მომავალი დრო.</p>}
          {originalError && <div className="admin-error">{originalError}<button type="button" disabled={busy} onClick={() => setOriginalRevision(value => value + 1)}>თავდაპირველი დროის ხელახლა შემოწმება</button></div>}
        </>}
      </div>}
      {needsSchedule && <>
        <fieldset className="admin-operator-group" role="group" aria-label="თარიღი"><legend>თარიღი</legend><div className="admin-operator-days">{days.map((day, index) => { const label = ['დღეს', 'ხვალ', 'ზეგ'][index]; return <button type="button" key={day} aria-label={`${label}, ${dateLabel(day)}`} aria-pressed={fields.requestedDate === day} disabled={busy} onClick={() => update('requestedDate', day)}><span>{label}</span><small>{dateLabel(day)}</small></button>; })}</div></fieldset>
        <fieldset className="admin-operator-group" role="group" aria-label="დრო"><legend>დრო</legend>{scheduleLoading || !schedule ? <p className="admin-operator-time-status" role="status">{scheduleError ? 'განრიგი ვერ ჩაიტვირთა.' : 'დროები იტვირთება…'}</p> : activeTimes.length ? <div className="admin-operator-times">{activeTimes.map(slot => <button type="button" key={slot} aria-pressed={fields.requestedTime === slot} disabled={busy} onClick={() => update('requestedTime', slot)}>{slot}</button>)}</div> : <div className="admin-notice">მომავალი მოქმედი დრო არ არის. აირჩიეთ ხვალ ან ზეგ.</div>}</fieldset>
        {scheduleError && <div className="admin-error" role="alert">{scheduleError}<button type="button" disabled={busy} onClick={() => setScheduleRevision(value => value + 1)}>განრიგის ხელახლა ჩატვირთვა</button></div>}
        {!scheduleLoading && schedule && activeTimes.length > 0 && !fields.requestedTime && <p className="admin-form-hint">აირჩიეთ მომავალი მოქმედი დრო. ჯავშანი ავტომატურად არ გადაიტანება.</p>}
        {modal.kind === 'confirm' && <p className="admin-form-hint"><CheckCircle2 size={16} />დამატება განაცხადს ავტომატურად დაადასტურებს.</p>}
      </>}
    </>}
    {modal.kind === 'restore' && booking?.status === 'waiting' && <p className="admin-form-hint"><Inbox size={16} />განაცხადი შემოსულების რიგში დაბრუნდება და დადასტურებას დაელოდება.</p>}
    {error && <div className="admin-error" role="alert">{error}</div>}
    <footer className="admin-dialog-footer"><button type="button" className="admin-secondary" disabled={busy} onClick={onClose}>გაუქმება</button><button className={modal.kind === 'delete' ? 'admin-danger-button' : 'admin-primary'} disabled={busy || !detailsValid || !restoreReady || (needsSchedule && !scheduleValid)}>{busy && <Loader2 size={17} className="admin-spin" />}{actionLabel}</button></footer>
  </form></Dialog>;
}


function AnalyticsPanel({ refresh }: { refresh: number }) {
  const [from, setFrom] = useState(() => addDays(today(), -6));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; if (from > to) { setError('საწყისი თარიღი უნდა იყოს საბოლოო თარიღამდე.'); setLoading(false); return; } setLoading(true); setError(''); request<Analytics>(`/admin/analytics?${query({ from, to })}`).then(result => { if (active) setData(result); }).catch(cause => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [from, to, refresh]);
  const max = Math.max(1, ...(data?.days.map(day => day.orders) || []));
  return <div className="admin-analytics"><section className="admin-analytics-period"><div><h2>მგზავრობების მიმოხილვა</h2><p>ჯავშნები და ადგილების რაოდენობა არჩეულ პერიოდში</p></div><div><label>დან<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label><label>მდე<input type="date" value={to} min={from} onChange={event => setTo(event.target.value)} /></label></div></section>{error && <div className="admin-error">{error}</div>}{loading ? <Loading /> : data && <><div className="admin-stat-grid">{[{ label: 'შემოსული განაცხადები', value: data.totals.incoming, icon: Inbox, className: 'amber' }, { label: 'დადასტურებული ჯავშნები', value: data.totals.confirmed, icon: CheckCircle2, className: 'green' }, { label: 'ადგილები', value: data.totals.seats, icon: Users, className: 'blue' }, { label: 'წაშლილი ჯავშნები', value: data.totals.deleted, icon: History, className: 'gray' }].map(({ label, value, icon: Icon, className }) => <div className="admin-stat-card" key={label}><span className={className}><Icon size={21} /></span><small>{label}</small><strong>{value}</strong></div>)}</div><div className="admin-analytics-grid"><section className="admin-chart-card"><h2>ჯავშნები დღეების მიხედვით</h2>{data.days.length ? <div className="admin-chart-scroll"><div className="admin-bar-chart">{data.days.map(day => <div className="admin-bar-column" key={day.date}><span>{day.orders}</span><div className="admin-bar-track"><div className="admin-chart-bar" style={{ height: `${Math.max(day.orders ? 5 : 0, day.orders / max * 100)}%` }} title={`${day.orders} ჯავშანი · ${day.seats} ადგილი`} /></div><small>{dateLabel(day.date)}</small></div>)}</div></div> : <p className="admin-muted">ამ პერიოდში ჯავშნები არ არის.</p>}</section><section className="admin-chart-card"><h2>მიმართულებები</h2>{data.directions.map(item => <div className="admin-direction-stat" key={item.direction}><div><MapPin size={19} /><strong>{directions[item.direction]}</strong></div><p><b>{item.orders}</b> ჯავშანი <span>· {item.seats} ადგილი</span></p><div className="admin-direction-track"><span style={{ width: `${data.totals.confirmed ? Math.min(100, item.orders / data.totals.confirmed * 100) : 0}%` }} /></div></div>)}</section></div></>}</div>;
}
