import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRightLeft, BarChart3, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Edit3, History, Inbox, Leaf, Loader2, LogOut, MapPin, Menu, MoreHorizontal, Phone, Plus, RefreshCw, Search, Settings, Trash2, Users, X } from 'lucide-react';
import { ApiError, addDays, directions, request, today, type Analytics, type Booking, type CallInquiry, type Direction, type Passenger, type PublicConfig, type Schedule, type User } from '../api';
import AdminSettings from './admin/AdminSettings';
import CallQueue from './admin/CallQueue';
import usePassengerProfile, { canonicalPassengerPhone } from './admin/usePassengerProfile';
import sidebarNight from '../assets/sidebar-night.webp';
import './admin.css';
import './admin-reference.css';

type View = 'scheduled' | 'incoming' | 'passengers' | 'analytics' | 'settings' | 'history';
type Modal = { kind: 'create'; inquiry?: CallInquiry } | { kind: 'edit' | 'confirm' | 'move' | 'delete' | 'restore'; booking: Booking };
type BookingFields = { name: string; phone: string; seats: number; direction: Direction; requestedDate: string; requestedTime: string; goriAddress: string; pickupStopId: number | null };
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
    const load = () => Promise.allSettled([request<{ bookings: Booking[] }>('/admin/bookings?scope=incoming'), request<PublicConfig>('/public/config'), request<{ calls: CallInquiry[] }>('/admin/calls?scope=incoming')]).then(results => {
      if (!active) return;
      if (results[0].status === 'fulfilled' && results[2].status === 'fulfilled') setIncomingCount(results[0].value.bookings.length + results[2].value.calls.length);
      if (results[1].status === 'fulfilled') setConfig(results[1].value);
    });
    void load();
    const timer = window.setInterval(() => { void load(); }, 12_000);
    return () => { active = false; window.clearInterval(timer); };
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
          <div className="admin-filter admin-toolbar-actions"><button className="admin-toolbar-create" aria-label="ახალი ჯავშანი" onClick={() => setModal({ kind: 'create' })}><Plus size={25} /><span><small>ახალი ჯავშანი</small><strong>შექმნა</strong></span></button><button className="admin-icon-button admin-toolbar-refresh" onClick={reload} disabled={loading} aria-label="განახლება" title="განახლება"><RefreshCw size={16} /></button></div>
          <label className="admin-filter admin-search"><span><small className="admin-search-label"><Search size={21} />მგზავრის სახელი ან ტელეფონი</small><span className="admin-search-field"><Search size={20} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="ძებნა…" aria-label="მგზავრის სახელი ან ტელეფონი" /></span></span></label>
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
          {error ? <div className="admin-error">{error}<button onClick={reload}>ხელახლა ცდა</button></div> : loading ? <Loading /> : bookings.length === 0 ? <Empty icon={view === 'incoming' ? Inbox : view === 'history' ? History : CalendarDays} title={searchQuery ? 'ჯავშანი ვერ მოიძებნა' : view === 'incoming' ? 'საიტიდან განაცხადები ჯერ არ არის' : view === 'history' ? 'წაშლილი ჯავშნები არ არის' : 'ამ დროისთვის ჯავშნები არ არის'} text={searchQuery ? 'სცადეთ სხვა სახელი ან ტელეფონის ნომერი.' : view === 'scheduled' ? 'შექმენით ჯავშანი ან დაამატეთ განაცხადი შემოსულებიდან.' : view === 'incoming' ? 'მგზავრის მიერ გამოგზავნილი განაცხადები აქ გამოჩნდება.' : 'წაშლილი ჯავშნები აქ გამოჩნდება.'} /> : <><div className="admin-table-scroll"><table className="admin-booking-table"><thead><tr><th><span className="admin-time-column-heading">{view === 'scheduled' ? 'დრო' : 'თარიღი / დრო'}{view === 'scheduled' && <ChevronDown size={14} />}</span></th><th>მგზავრი</th><th>ტელეფონი</th><th>მიმართულება</th><th>აყვანის ადგილი</th><th>ჩამოსვლის ადგილი</th><th className="admin-center">ადგილები</th><th>სტატუსი</th><th className="admin-actions-heading">მოქმედება</th></tr></thead><tbody>{visibleBookings.map(booking => <tr key={booking.id}>
            <td>{view === 'scheduled' ? <button className="admin-row-time" aria-label={`${booking.name}: დროის შეცვლა`} onClick={() => setModal({ kind: 'move', booking })}><strong className="admin-time-value">{booking.assignedTime || booking.requestedTime}</strong><ChevronDown size={14} /></button> : <><strong className="admin-time-value">{booking.assignedTime || booking.requestedTime}</strong><small className="admin-cell-subtitle">{dateLabel(booking.assignedDate || booking.requestedDate)}</small></>}</td><td><strong className="admin-passenger-name">{booking.name}</strong>{view !== 'scheduled' && <small className="admin-cell-subtitle">#{String(booking.id).padStart(4, '0')}</small>}</td><td className="admin-phone-cell"><a href={`tel:${booking.phone}`}>{booking.phone}</a></td><td className="admin-direction-cell">{directions[booking.direction]}</td><td>{booking.direction === 'gori-tbilisi' ? booking.goriAddress : booking.pickupStopName || 'გაჩერება არ არის მითითებული'}</td><td>{booking.direction === 'gori-tbilisi' ? booking.didubeName : booking.goriAddress}</td><td className="admin-center"><span className="admin-seat-badge">{booking.seats}</span></td><td><span className={`admin-status ${booking.status === 'confirmed' ? 'confirmed' : 'waiting'}`}>{statusLabel(booking)}</span></td><td><div className="admin-row-actions">{view === 'incoming' ? <button className="admin-confirm-button" onClick={() => setModal({ kind: 'confirm', booking })}><Check size={15} /> დამატება</button> : view === 'history' ? <button className="admin-restore-button" onClick={() => setModal({ kind: 'restore', booking })}><History size={15} /> აღდგენა</button> : <a className="admin-icon-button" href={`tel:${booking.phone}`} aria-label={`${booking.name}: დარეკვა`}><Phone size={15} /></a>}{view !== 'history' && <><button className="admin-icon-button" onClick={() => setModal({ kind: 'edit', booking })} aria-label={`${booking.name}: რედაქტირება`}><Edit3 size={15} /></button><div className="admin-more-wrap"><button className="admin-icon-button" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenuPosition({ top: Math.min(rect.bottom + 5, window.innerHeight - 140), left: Math.max(8, rect.right - 139) }); setMenuId(menuId === booking.id ? null : booking.id); }} aria-label={`${booking.name}: სხვა მოქმედებები`} aria-expanded={menuId === booking.id}><MoreHorizontal size={19} /></button>{menuId === booking.id && <><button className="admin-menu-dismiss" onClick={() => setMenuId(null)} aria-label="მოქმედებების დახურვა" /><div className="admin-row-menu" style={{ position: 'fixed', top: menuPosition.top, left: menuPosition.left, right: 'auto' }}>{view === 'scheduled' && <button onClick={() => { setModal({ kind: 'move', booking }); setMenuId(null); }}><ArrowRightLeft size={15} /> გადატანა</button>}<a href={`tel:${booking.phone}`}><Phone size={15} /> დარეკვა</a><button className="admin-danger-text" onClick={() => { setModal({ kind: 'delete', booking }); setMenuId(null); }}><Trash2 size={15} /> წაშლა</button></div></>}</div></>}</div></td>
          </tr>)}</tbody></table></div><div className="admin-pagination"><div className="admin-page-buttons"><button className="admin-icon-button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="წინა გვერდი"><ChevronLeft size={18} /></button>{Array.from({ length: Math.min(pageCount, 5) }, (_, index) => { const value = Math.max(1, Math.min(page - 2, pageCount - 4)) + index; return <button className={page === value ? 'selected' : ''} key={value} onClick={() => setPage(value)}>{value}</button>; })}<button className="admin-icon-button" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label="შემდეგი გვერდი"><ChevronRight size={18} /></button><span>{Math.min((page - 1) * pageSize + 1, bookings.length)}–{Math.min(page * pageSize, bookings.length)} / {bookings.length}</span></div><label>ჩანაწერები გვერდზე<select value={pageSize} onChange={event => setPageSize(Number(event.target.value))}><option>15</option><option>30</option><option>50</option></select></label></div></>}
        </section>
      </>}
      {view === 'passengers' && <section className="admin-table-card"><div className="admin-table-heading"><div><h2>მგზავრების სია</h2><span>მგზავრები გაერთიანებულია ტელეფონის ნომრის მიხედვით</span></div><label className="admin-inline-search"><Search size={18} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="სახელი ან ტელეფონი" /></label></div>{error ? <div className="admin-error">{error}<button onClick={reload}>ხელახლა ცდა</button></div> : loading ? <Loading /> : passengers.length === 0 ? <Empty icon={Users} title="მგზავრი ვერ მოიძებნა" text="პირველი ჯავშნის შემდეგ მგზავრი ამ სიაში გამოჩნდება." /> : <div className="admin-table-scroll"><table className="admin-booking-table admin-passengers-table"><thead><tr><th>მგზავრი</th><th>ტელეფონი</th><th>ჯავშნები</th><th>ადგილები</th><th>ბოლო მგზავრობა</th><th>მოქმედება</th></tr></thead><tbody>{passengers.map(passenger => <tr key={passenger.phone}><td><strong>{passenger.name}</strong></td><td>{passenger.phone}</td><td>{passenger.orderCount}</td><td>{passenger.seats}</td><td>{dateLabel(passenger.latestDate, { day: 'numeric', month: 'long', year: 'numeric' })}</td><td><a className="admin-icon-button" href={`tel:${passenger.phone}`} aria-label={`${passenger.name}: დარეკვა`}><Phone size={16} /></a></td></tr>)}</tbody></table></div>}</section>}
      {view === 'analytics' && <AnalyticsPanel refresh={refresh} />}
      {view === 'settings' && <AdminSettings onChange={reload} />}
      <footer className="admin-footer"><span><span className="admin-live-dot" /> Green Taxi</span><span>გორი ↔ თბილისი</span></footer>
    </main>
    {modal && <BookingModal modal={modal} config={config} defaultDirection={direction} defaultDate={date} defaultTime={time} onClose={() => setModal(null)} onComplete={completed} />}
    {toast && <div className="admin-toast" role="status"><CheckCircle2 size={19} />{toast}<button onClick={() => setToast('')} aria-label="შეტყობინების დახურვა"><X size={16} /></button></div>}
  </div>;
}

function Loading() { return <div className="admin-loading" role="status"><Loader2 size={25} className="admin-spin" /><span>მონაცემები იტვირთება…</span></div>; }
function Empty({ icon: Icon, title, text }: { icon: typeof Inbox; title: string; text: string }) { return <div className="admin-empty"><span><Icon size={30} /></span><h3>{title}</h3><p>{text}</p></div>; }

function Dialog({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; document.addEventListener('keydown', onKey); return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', onKey); }; }, [onClose]);
  return <div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title"><header><div><h2 id="admin-dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="admin-icon-button" onClick={onClose} aria-label="დახურვა"><X size={21} /></button></header>{children}</section></div>;
}

function BookingModal({ modal, config, defaultDirection, defaultDate, defaultTime, onClose, onComplete }: { modal: Modal; config: PublicConfig; defaultDirection: Direction; defaultDate: string; defaultTime: string; onClose: () => void; onComplete: (message: string) => void }) {
  const booking = 'booking' in modal ? modal.booking : undefined;
  const inquiry = modal.kind === 'create' ? modal.inquiry : undefined;
  const [fields, setFields] = useState<BookingFields>(() => ({ name: booking?.name || '', phone: booking?.phone || inquiry?.phone || '', seats: booking?.seats || 1, direction: booking?.direction || defaultDirection, requestedDate: booking?.assignedDate || booking?.requestedDate || (inquiry && defaultDate < today() ? today() : defaultDate), requestedTime: booking?.assignedTime || booking?.requestedTime || defaultTime, goriAddress: booking?.goriAddress || '', pickupStopId: booking?.pickupStopId || null }));
  const provenance = useRef<Record<'name' | 'goriAddress' | 'pickupStopId', 'empty' | 'profile' | 'manual'>>({ name: 'empty', goriAddress: 'empty', pickupStopId: 'empty' });
  const profilePhone = useRef(canonicalPassengerPhone(fields.phone));
  const idempotencyKey = useRef(crypto.randomUUID());
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [scheduleRevision, setScheduleRevision] = useState(0);
  const needsSchedule = modal.kind !== 'edit' && modal.kind !== 'delete' && !(modal.kind === 'restore' && booking?.status === 'waiting');
  const isDetails = modal.kind === 'create' || modal.kind === 'edit';
  const activeTimes = schedule?.slots.filter(slot => slot.active).map(slot => slot.time) || [];
  const passengerProfile = usePassengerProfile(fields.phone, modal.kind === 'create' && !busy);
  useEffect(() => {
    const profile = passengerProfile.profile;
    if (!profile || modal.kind !== 'create' || busy || canonicalPassengerPhone(profile.phone) !== canonicalPassengerPhone(fields.phone)) return;
    const changes: Partial<BookingFields> = {};
    if (provenance.current.name !== 'manual') { changes.name = profile.name; provenance.current.name = 'profile'; }
    if (provenance.current.goriAddress !== 'manual') { changes.goriAddress = profile.goriAddress; provenance.current.goriAddress = 'profile'; }
    if (provenance.current.pickupStopId !== 'manual') {
      const activeStop = profile.pickupStopId !== null && config.stops.some(stop => stop.active && stop.id === profile.pickupStopId);
      if (fields.direction === 'tbilisi-gori' && activeStop) { changes.pickupStopId = profile.pickupStopId; provenance.current.pickupStopId = 'profile'; }
      else if (!activeStop && (fields.direction === 'tbilisi-gori' || provenance.current.pickupStopId === 'profile')) { changes.pickupStopId = null; provenance.current.pickupStopId = 'empty'; }
    }
    setFields(current => {
      if (canonicalPassengerPhone(current.phone) !== canonicalPassengerPhone(profile.phone)) return current;
      const applicable = { ...changes };
      for (const key of ['name', 'goriAddress', 'pickupStopId'] as const) if (provenance.current[key] === 'manual') delete applicable[key];
      if (Object.entries(applicable).every(([key, value]) => current[key as keyof BookingFields] === value)) return current;
      return { ...current, ...applicable };
    });
  }, [passengerProfile.profile, fields.phone, fields.direction, config.stops, modal.kind, busy]);
  function update<K extends keyof BookingFields>(key: K, value: BookingFields[K]) {
    const reset: Partial<BookingFields> = {};
    if (modal.kind === 'create') {
      if (key === 'name' || key === 'goriAddress' || key === 'pickupStopId') provenance.current[key as keyof typeof provenance.current] = 'manual';
      if (key === 'phone') {
        const nextPhone = canonicalPassengerPhone(String(value));
        if (profilePhone.current !== nextPhone) {
          if (provenance.current.name === 'profile') { reset.name = ''; provenance.current.name = 'empty'; }
          if (provenance.current.goriAddress === 'profile') { reset.goriAddress = ''; provenance.current.goriAddress = 'empty'; }
          if (provenance.current.pickupStopId === 'profile') { reset.pickupStopId = null; provenance.current.pickupStopId = 'empty'; }
        }
        profilePhone.current = nextPhone;
      }
    }
    setFields(current => ({ ...current, ...reset, [key]: value }));
  }
  useEffect(() => {
    if (!needsSchedule) return;
    let active = true; setScheduleLoading(true); setScheduleError(''); setSchedule(null);
    request<Schedule>(`/admin/schedule?${query({ direction: fields.direction, date: fields.requestedDate })}`).then(result => { if (active) { setSchedule(result); setFields(current => { const available = result.slots.filter(slot => slot.active); return { ...current, requestedTime: available.some(slot => slot.time === current.requestedTime) ? current.requestedTime : modal.kind === 'create' ? available[0]?.time || '' : '' }; }); } }).catch(cause => { if (active) setScheduleError(errorMessage(cause)); }).finally(() => { if (active) setScheduleLoading(false); });
    return () => { active = false; };
  }, [fields.direction, fields.requestedDate, needsSchedule, scheduleRevision, modal.kind]);
  const title = { create: 'ახალი ჯავშანი', edit: 'ჯავშნის რედაქტირება', confirm: 'განაცხადის დამატება', move: 'ჯავშნის გადატანა', delete: 'ჯავშნის წაშლა', restore: 'ჯავშნის აღდგენა' }[modal.kind];
  const actionLabel = { create: 'შექმნა და დადასტურება', edit: 'ცვლილებების შენახვა', confirm: 'დამატება და დადასტურება', move: 'გადატანა', delete: 'წაშლა', restore: 'აღდგენა' }[modal.kind];
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (needsSchedule && !activeTimes.includes(fields.requestedTime)) { setError('აირჩიეთ მოქმედი დრო.'); return; }
    setBusy(true); setError('');
    try {
      if (modal.kind === 'create') await request<Booking>(inquiry ? `/admin/calls/${inquiry.id}/convert` : '/admin/bookings', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey.current }, body: JSON.stringify({ ...fields, pickupStopId: fields.direction === 'tbilisi-gori' ? fields.pickupStopId : null }) });
      else if (modal.kind === 'edit') await request<Booking>(`/admin/bookings/${modal.booking.id}`, { method: 'PATCH', body: JSON.stringify({ name: fields.name, phone: fields.phone, seats: fields.seats, goriAddress: fields.goriAddress, pickupStopId: fields.direction === 'tbilisi-gori' ? fields.pickupStopId : null }) });
      else await request<Booking>(`/admin/bookings/${modal.booking.id}/${modal.kind}`, { method: 'POST', body: JSON.stringify(modal.kind === 'delete' ? {} : { date: fields.requestedDate, time: fields.requestedTime }) });
      onComplete({ create: 'ჯავშანი შეიქმნა და დადასტურდა', edit: 'ცვლილებები შენახულია', confirm: 'ჯავშანი დაემატა და დადასტურდა', move: 'ჯავშანი გადატანილია', delete: 'ჯავშანი გადატანილია ისტორიაში', restore: 'ჯავშანი აღდგენილია' }[modal.kind]);
    } catch (cause) { setError(errorMessage(cause)); if (cause instanceof ApiError && cause.code === 'SLOT_INACTIVE') setScheduleRevision(value => value + 1); setBusy(false); }
  }
  return <Dialog title={inquiry ? 'ზარის მიხედვით ჯავშნის შექმნა' : title} subtitle={booking ? `${booking.name} · ${booking.phone} · #${String(booking.id).padStart(4, '0')}` : inquiry ? 'შეავსეთ მგზავრობის მონაცემები. ზარი დადასტურებულ ჯავშნად გადაიქცევა.' : 'ოპერატორის მიერ შექმნილი ჯავშანი მაშინვე დადასტურდება.'} onClose={() => { if (!busy) onClose(); }}><form onSubmit={submit} className="admin-booking-form">
    {modal.kind === 'delete' ? <div className="admin-delete-body"><span><Trash2 size={27} /></span><p>ნამდვილად გსურთ ამ ჯავშნის წაშლა?</p><small>მონაცემები ისტორიაში შენარჩუნდება. ჯავშნის აღდგენა ნებისმიერ დროს შეგიძლიათ.</small></div> : <>
      {isDetails && <><div className="admin-form-grid"><label>მგზავრის სახელი<input autoFocus required minLength={2} maxLength={100} value={fields.name} onChange={event => update('name', event.target.value)} placeholder="სახელი და გვარი" /></label><label>ტელეფონის ნომერი<input required type="tel" maxLength={30} value={fields.phone} onChange={event => update('phone', event.target.value)} placeholder="მაგ. 555 12 34 56" /></label></div>
      {modal.kind === 'create' && passengerProfile.status === 'loading' && <p className="admin-form-hint admin-profile-feedback" role="status"><Loader2 size={15} className="admin-spin" />მგზავრის მონაცემების ძიება…</p>}
      {modal.kind === 'create' && passengerProfile.status === 'found' && <p className="admin-form-hint admin-profile-feedback" role="status"><CheckCircle2 size={16} /><span>მგზავრი ნაპოვნია. შენახული მონაცემები მხოლოდ შეუცვლელ ველებში ივსება; თქვენ მიერ შეცვლილი ან გასუფთავებული ველები შენარჩუნდება.</span></p>}
      {modal.kind === 'create' && passengerProfile.status === 'error' && <p className="admin-form-hint admin-profile-feedback admin-profile-error" role="status"><span>მონაცემები ვერ ჩაიტვირთა. ფორმის შევსება შეგიძლიათ ხელით.</span><button type="button" className="admin-text-button" onClick={passengerProfile.retry}>ხელახლა ცდა</button></p>}
      <div className="admin-form-grid"><label>მიმართულება<select aria-label="მიმართულება" disabled={modal.kind === 'edit'} value={fields.direction} onChange={event => update('direction', event.target.value as Direction)}>{Object.entries(directions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>ადგილების რაოდენობა<select aria-label="ადგილების რაოდენობა" value={fields.seats} onChange={event => update('seats', Number(event.target.value))}>{[1, 2, 3, 4].map(count => <option value={count} key={count}>{count} ადგილი</option>)}</select></label></div>
      {fields.direction === 'tbilisi-gori' && <label>აყვანის ადგილი თბილისში<select aria-label="აყვანის ადგილი თბილისში" required value={fields.pickupStopId || ''} onChange={event => update('pickupStopId', Number(event.target.value))}><option value="" disabled>აირჩიეთ გაჩერება</option>{booking?.pickupStopId && !config.stops.some(stop => stop.id === booking.pickupStopId) && <option value={booking.pickupStopId}>{booking.pickupStopName} (გამორთული)</option>}{config.stops.map(stop => <option key={stop.id} value={stop.id}>{stop.name} — {stop.address}</option>)}</select>{!config.stops.length && !booking?.pickupStopId && <small className="admin-danger-text">ჯერ დაამატეთ მოქმედი გაჩერება პარამეტრებში.</small>}</label>}
      <label>{fields.direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'}<textarea aria-label={fields.direction === 'gori-tbilisi' ? 'აყვანის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'} required minLength={3} maxLength={500} rows={2} value={fields.goriAddress} onChange={event => update('goriAddress', event.target.value)} placeholder="ქუჩა, სახლის ნომერი, ორიენტირი" /><small>მისამართი უნდა იყოს გორის ფარგლებში.</small></label>{fields.direction === 'gori-tbilisi' && <div className="admin-fixed-stop"><MapPin size={19} /><div><small>ჩამოსვლის ადგილი თბილისში</small><strong>{booking?.didubeName || config.didubeName}</strong>{(booking?.didubeAddress || config.didubeAddress) && <span>{booking?.didubeAddress || config.didubeAddress}</span>}</div></div>}
      </>}
      {!isDetails && <div className="admin-order-summary"><ArrowRightLeft size={18} /><strong>{directions[fields.direction]}</strong><span>{fields.seats} ადგილი</span></div>}
      {needsSchedule && <><div className="admin-form-grid"><label>თარიღი<input required type="date" value={fields.requestedDate} onChange={event => update('requestedDate', event.target.value)} /></label><label>დრო<select aria-label="დრო" required disabled={scheduleLoading || activeTimes.length === 0} value={fields.requestedTime} onChange={event => update('requestedTime', event.target.value)}>{scheduleLoading ? <option value="">იტვირთება…</option> : activeTimes.length ? <>{!fields.requestedTime && <option value="">აირჩიეთ მოქმედი დრო</option>}{activeTimes.map(slot => <option key={slot} value={slot}>{slot}</option>)}</> : <option value="">მოქმედი დრო არ არის</option>}</select></label></div>{scheduleError && <div className="admin-error">{scheduleError}</div>}{!scheduleLoading && activeTimes.length > 0 && !fields.requestedTime && <div className="admin-notice">არჩეული დრო გამორთულია. აირჩიეთ მოქმედი დრო — ჯავშნის გადატანა ავტომატურად არ მოხდება.</div>}{!scheduleLoading && schedule && !activeTimes.length && <div className="admin-notice">ამ თარიღისთვის ყველა დრო გამორთულია. აირჩიეთ სხვა თარიღი ან შეცვალეთ განრიგი.</div>}{modal.kind === 'confirm' && <p className="admin-form-hint"><CheckCircle2 size={16} />სლოტში დამატება განაცხადს ავტომატურად დაადასტურებს.</p>}{modal.kind === 'restore' && <p className="admin-form-hint"><History size={16} />ჯავშანი აღდგება მის წინა სტატუსთან ერთად. საჭიროების შემთხვევაში აირჩიეთ ახალი დრო.</p>}</>}
    </>}
    {modal.kind === 'restore' && booking?.status === 'waiting' && <p className="admin-form-hint"><Inbox size={16} />განაცხადი შემოსულების რიგში დაბრუნდება და დადასტურებას დაელოდება.</p>}
    {error && <div className="admin-error" role="alert">{error}</div>}
    <footer className="admin-dialog-footer"><button type="button" className="admin-secondary" disabled={busy} onClick={onClose}>გაუქმება</button><button className={modal.kind === 'delete' ? 'admin-danger-button' : 'admin-primary'} disabled={busy || (needsSchedule && (scheduleLoading || !activeTimes.includes(fields.requestedTime)))}>{busy && <Loader2 size={17} className="admin-spin" />}{actionLabel}</button></footer>
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
