import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, History, Loader2, MapPin, Phone, RefreshCw, Search } from 'lucide-react';
import { ApiError, directions, request, type Booking, type Passenger, type PassengerDetail, type PublicConfig } from '../../api';
import { formatPhone, phoneDialNumber } from '../../../shared/phone';
import './passengers.css';

type Props = { phone: string | null; refresh: number; config: PublicConfig; onOpen: (phone: string) => void; onBack: () => void };
type HistoryFilter = 'past' | 'upcoming' | 'all' | 'waiting' | 'deleted';
const filters: { value: HistoryFilter; label: string }[] = [
  { value: 'past', label: 'წარსული' }, { value: 'upcoming', label: 'დაგეგმილი' },
  { value: 'all', label: 'ყველა' }, { value: 'waiting', label: 'დასადასტურებელი' }, { value: 'deleted', label: 'წაშლილი' },
];
const months = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
function dateLabel(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return match ? `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}` : '—';
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.'; }
function passengerHref(phone: string) {
  const path = `/admin/passengers/${encodeURIComponent(phone)}`;
  return window.location.pathname.startsWith('/admin') ? path : `#${path.slice(1)}`;
}
function historyCategory(booking: Booking, now: number): Exclude<HistoryFilter, 'all'> {
  if (booking.deletedAt) return 'deleted';
  if (booking.status === 'waiting') return 'waiting';
  const timestamp = new Date(`${booking.assignedDate || booking.requestedDate}T${booking.assignedTime || booking.requestedTime}:00+04:00`).getTime();
  return timestamp > now ? 'upcoming' : 'past';
}
function Loading() { return <div className="passengers-loading" role="status"><Loader2 className="admin-spin" size={24} />მონაცემები იტვირთება…</div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="passengers-empty"><History size={30} /><h3>{title}</h3><p>{text}</p></div>; }
function Pagination({ count, page, size, onPage, onSize, label }: { count: number; page: number; size: number; onPage: (page: number) => void; onSize: (size: number) => void; label: string }) {
  const pageCount = Math.max(1, Math.ceil(count / size));
  return <div className="passengers-pagination">
    <div><button type="button" className="admin-icon-button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={`${label}: წინა გვერდი`}><ChevronLeft size={18} /></button><span>{page} / {pageCount}</span><button type="button" className="admin-icon-button" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label={`${label}: შემდეგი გვერდი`}><ChevronRight size={18} /></button><small>{count ? (page - 1) * size + 1 : 0}–{Math.min(page * size, count)} / {count}</small></div>
    <label>ჩანაწერები გვერდზე<select value={size} onChange={event => onSize(Number(event.target.value))} aria-label={`${label}: ჩანაწერები გვერდზე`}><option>15</option><option>30</option><option>50</option></select></label>
  </div>;
}

export default function Passengers({ phone, refresh, config, onOpen, onBack }: Props) {
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const listSequence = useRef(0);

  useEffect(() => { const timer = window.setTimeout(() => setSearchQuery(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (phone !== null) return;
    const sequence = ++listSequence.current;
    const controller = new AbortController();
    setLoading(true); setError('');
    const parameters = new URLSearchParams();
    if (searchQuery) parameters.set('search', searchQuery);
    request<{ passengers: Passenger[] }>(`/admin/passengers?${parameters}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && sequence === listSequence.current) setPassengers(result.passengers);
    }).catch(cause => { if (!controller.signal.aborted && sequence === listSequence.current) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted && sequence === listSequence.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [searchQuery, phone, refresh, revision]);
  useEffect(() => {
    const update = () => { if (document.visibilityState !== 'hidden') setRevision(value => value + 1); };
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const pageCount = Math.max(1, Math.ceil(passengers.length / size));
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);

  return <div className="passengers-workspace">{phone !== null ? <PassengerHistory key={phone} phone={phone} refresh={refresh} config={config} onBack={onBack} /> : <section className="admin-table-card passengers-list">
    <div className="passengers-list-heading"><div><h2>მგზავრების სია</h2><p>მგზავრები გაერთიანებულია ტელეფონის ნომრის მიხედვით</p></div><div className="passengers-list-tools"><label className="passengers-search"><Search size={18} /><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="მისამართი ან ტელეფონი" aria-label="მისამართი ან ტელეფონი" /></label><button type="button" className="admin-icon-button" onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label="მგზავრების განახლება"><RefreshCw size={17} /></button></div></div>
    {error ? <div className="passengers-error" role="alert">{error}<button className="admin-secondary" onClick={() => setRevision(value => value + 1)}>ხელახლა ცდა</button></div> : loading ? <Loading /> : passengers.length === 0 ? <Empty title="მგზავრი ვერ მოიძებნა" text={searchQuery ? 'სცადეთ სხვა მისამართი ან ტელეფონის ნომერი.' : 'პირველი ჯავშნის შემდეგ მგზავრი ამ სიაში გამოჩნდება.'} /> : <>
      <div className="passengers-table-wrap"><table className="passengers-table" aria-label="მგზავრების სია"><thead><tr><th>მისამართი</th><th>ტელეფონი</th><th>ჯავშნები</th><th>ადგილები</th><th>ბოლო ჯავშანი</th><th>მოქმედება</th></tr></thead><tbody>{passengers.slice((page - 1) * size, page * size).map(passenger => <tr key={passenger.phone} data-passenger-phone={passenger.phone}>
        <td data-label="მისამართი"><a className="passengers-address" href={passengerHref(passenger.phone)} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen(passenger.phone); } }} aria-label={`${formatPhone(passenger.phone)}: მგზავრობის ისტორია`}><strong>{passenger.address || 'მისამართი არ არის მითითებული'}</strong>{passenger.addressCity && <small>{passenger.addressCity === 'gori' ? 'გორი' : 'თბილისი'}</small>}</a></td>
        <td data-label="ტელეფონი" className="passengers-phone">{formatPhone(passenger.phone)}</td><td data-label="ჯავშნები">{passenger.orderCount}</td><td data-label="ადგილები">{passenger.seats}</td><td data-label="ბოლო ჯავშანი">{dateLabel(passenger.latestDate)}</td><td data-label="მოქმედება"><div className="passengers-row-actions"><a className="passengers-history-link" href={passengerHref(passenger.phone)} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen(passenger.phone); } }} aria-label={`${formatPhone(passenger.phone)}: ისტორიის გახსნა`}><History size={16} /><span>ისტორია</span><ArrowUpRight size={14} /></a><a className="admin-icon-button" href={`tel:${phoneDialNumber(passenger.phone) || passenger.phone}`} aria-label={`${formatPhone(passenger.phone)}: დარეკვა`}><Phone size={16} /></a></div></td>
      </tr>)}</tbody></table></div><Pagination count={passengers.length} page={page} size={size} onPage={setPage} onSize={value => { setSize(value); setPage(1); }} label="მგზავრები" />
    </>}
  </section>}</div>;
}

function PassengerHistory({ phone, refresh, config, onBack }: { phone: string; refresh: number; config: PublicConfig; onBack: () => void }) {
  const [detail, setDetail] = useState<PassengerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<HistoryFilter>('past');
  const [clock, setClock] = useState(Date.now);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setLoading(true); setError(''); setNotFound(false);
    request<PassengerDetail>(`/admin/passengers/${encodeURIComponent(phone)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted && current === sequence.current) setDetail(result);
    }).catch(cause => { if (!controller.signal.aborted && current === sequence.current) { setError(message(cause)); setNotFound(cause instanceof ApiError && cause.status === 404); } }).finally(() => { if (!controller.signal.aborted && current === sequence.current) setLoading(false); });
    return () => { controller.abort(); };
  }, [phone, refresh, revision]);
  useEffect(() => {
    const updateClock = () => { if (document.visibilityState !== 'hidden') setClock(Date.now()); };
    const update = () => { if (document.visibilityState !== 'hidden') { setClock(Date.now()); setRevision(value => value + 1); } };
    const timer = window.setInterval(updateClock, 15_000);
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const bookings = detail?.bookings || [];
  const categories = bookings.reduce((counts, booking) => { counts[historyCategory(booking, clock)] += 1; return counts; }, { past: 0, upcoming: 0, waiting: 0, deleted: 0 });
  const filtered = filter === 'all' ? bookings : bookings.filter(booking => historyCategory(booking, clock) === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  useEffect(() => { setPage(current => Math.min(current, pageCount)); }, [pageCount]);
  const visible = filtered.slice((page - 1) * size, page * size);
  const profile = detail?.profile;
  const goriPickupAddress = profile?.goriPickupAddress || (detail?.passenger.addressCity === 'gori' ? detail.passenger.address : '');
  const savedStop = config.stops.find(stop => stop.id === profile?.pickupStopId);
  const tbilisiPickupAddress = savedStop ? [savedStop.name, savedStop.address].filter(Boolean).join(' — ') : profile?.pickupStopName || (detail?.passenger.addressCity === 'tbilisi' ? detail.passenger.address : '');
  return <article className="passenger-history" aria-label="მგზავრის გვერდი">
    <button type="button" className="passengers-back" onClick={onBack} aria-label="მგზავრების სიაში დაბრუნება"><ArrowLeft size={18} />მგზავრების სია</button>
    <header className="passenger-profile-heading"><div><p>მგზავრობის ისტორია</p><h2>{formatPhone(phone)}</h2></div><div><a className="admin-primary" href={`tel:${phoneDialNumber(phone) || phone}`} aria-label={`${formatPhone(phone)}: დარეკვა`}><Phone size={17} />დარეკვა</a><button type="button" className="admin-icon-button" onClick={() => setRevision(value => value + 1)} disabled={loading} aria-label="მგზავრის ისტორიის განახლება"><RefreshCw size={18} /></button></div></header>
    {error ? <div className="admin-table-card passengers-error" role="alert"><strong>{notFound ? 'მგზავრი ვერ მოიძებნა' : 'ისტორია ვერ ჩაიტვირთა'}</strong><span>{error}</span>{!notFound && <button type="button" className="admin-secondary" onClick={() => setRevision(value => value + 1)}>ხელახლა ცდა</button>}</div> : loading ? <section className="admin-table-card"><Loading /></section> : detail && <>
      <section className="passenger-addresses" aria-label="შენახული მისამართები"><div><span><MapPin size={17} />გორი · აყვანის მისამართი</span><strong>{goriPickupAddress || 'მისამართი ჯერ არ არის შენახული'}</strong></div><div><span><MapPin size={17} />თბილისი · აყვანის გაჩერება</span><strong>{tbilisiPickupAddress || 'გაჩერება ჯერ არ არის შენახული'}</strong></div></section>
      <section className="passenger-summary" aria-label="მგზავრის ჯავშნების შეჯამება"><div><span>მოქმედი ჯავშნები</span><strong>{detail.passenger.orderCount}</strong></div><div><span>ჯამური ადგილები</span><strong>{detail.passenger.seats}</strong></div><div><span>წარსული ჯავშნები</span><strong>{categories.past}</strong></div><div><span>დაგეგმილი ჯავშნები</span><strong>{categories.upcoming}</strong></div></section>
      <section className="admin-table-card passenger-trips"><div className="passenger-trips-heading"><h3>მგზავრობის ისტორია</h3><p>თარიღები და საათები — თბილისის დროით</p><div className="passenger-history-filters" role="group" aria-label="მგზავრობის ისტორიის ფილტრი">{filters.map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} className={filter === item.value ? 'selected' : ''} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}<span>{item.value === 'all' ? bookings.length : categories[item.value]}</span></button>)}</div></div>
        {filtered.length === 0 ? <Empty title={filter === 'past' ? 'წარსული მგზავრობები ჯერ არ არის' : 'ამ კატეგორიაში ჯავშნები არ არის'} text={filter === 'past' && categories.upcoming ? 'მომავალი ჯავშნების სანახავად აირჩიეთ „დაგეგმილი“.' : 'სხვა ჩანაწერების სანახავად შეცვალეთ ფილტრი.'} /> : <>
          <div className="passengers-table-wrap"><table className="passengers-table passenger-trips-table" aria-label="მგზავრობის ისტორია"><thead><tr><th>თარიღი / დრო</th><th>მიმართულება</th><th>აყვანის მისამართი</th><th>ჩამოსვლის მისამართი</th><th>ადგილები</th><th>სტატუსი</th></tr></thead><tbody>{visible.map(booking => { const category = historyCategory(booking, clock); const pickup = booking.direction === 'gori-tbilisi' ? booking.goriAddress : booking.pickupStopName; return <tr key={booking.id} data-booking-id={booking.id} className={category === 'deleted' ? 'is-deleted' : ''}>
            <td data-label="თარიღი / დრო"><strong className="passenger-trip-date"><CalendarDays size={14} />{dateLabel(booking.assignedDate || booking.requestedDate)}</strong><small className="passenger-trip-time"><Clock3 size={13} />{booking.assignedTime || booking.requestedTime}<span>#{booking.id}</span></small></td><td data-label="მიმართულება">{directions[booking.direction]}</td><td data-label="აყვანის მისამართი">{pickup || 'მისამართი არ არის მითითებული'}</td><td data-label="ჩამოსვლის მისამართი">{booking.direction === 'tbilisi-gori' ? booking.goriAddress : <>{booking.didubeName}{booking.didubeAddress && <small className="passenger-trip-arrival">{booking.didubeAddress}</small>}</>}</td><td data-label="ადგილები"><span className="passenger-seats">{booking.seats}</span></td><td data-label="სტატუსი"><span className={`passenger-trip-status ${category}`}>{category === 'deleted' ? 'წაშლილი' : category === 'waiting' ? 'ელოდება დადასტურებას' : 'დადასტურებული'}</span>{category === 'past' && <small className="passenger-trip-note">წარსული ჯავშანი</small>}{category === 'upcoming' && <small className="passenger-trip-note">დაგეგმილი მგზავრობა</small>}</td>
          </tr>; })}</tbody></table></div><Pagination count={filtered.length} page={page} size={size} onPage={setPage} onSize={value => { setSize(value); setPage(1); }} label="მგზავრობის ისტორია" />
        </>}
      </section>
    </>}
  </article>;
}
