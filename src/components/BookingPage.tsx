import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2, ChevronRight, Clock3, Leaf, LoaderCircle, LockKeyhole, MapPin, Navigation, Phone, Users } from 'lucide-react';
import { directions, request, today, type Direction, type PublicConfig, type Slot } from '../api';
import './public.css';

type Field = 'date' | 'time' | 'name' | 'phone' | 'goriAddress' | 'stop';
type Errors = Partial<Record<Field, string>>;
type Receipt = { direction: Direction; date: string; time: string; seats: number };
type SlotState = { key: string; loading: boolean; slots: Slot[]; error: string };

function dateLabel(date: string) {
  const months = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
  const [, month, day] = date.split('-');
  return `${Number(day)} ${months[Number(month) - 1]}`;
}

function RouteArtwork() {
  return <div className="public-artwork" aria-hidden="true">
    <svg viewBox="0 0 640 250" fill="none" className="public-landscape">
      <path d="M0 168 75 115 130 152 224 67 270 104 305 84 420 167 490 121 552 161 595 135 640 174" stroke="currentColor" strokeWidth="1.2" />
      <path d="m183 103 41-36 46 37-23-8-23 13-13-11-28 5M0 196l90-22 94 13 89-32 91 26 72-9 72 19 132-10" stroke="currentColor" strokeWidth="1.2" />
      <path d="M70 175v-42h23v42m-26-42h29m-23-7 8-15 9 15M455 177v-53h21v53m4 0v-74h26v74m5 0v-41h27v41m3 0v-63h22v63m-73-63h6m-6 11h6m-6 11h6m-6 11h6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M92 208c100-70 159 45 234-1s130-22 202 0" stroke="#68d897" strokeWidth="2" strokeDasharray="4 7" />
      <circle cx="90" cy="208" r="6" fill="#68d897" /><circle cx="530" cy="208" r="6" fill="#68d897" />
      <path d="M294 191h37l8 8v16h-54v-16l9-8Z" fill="#d1f7df" />
      <path d="m299 195-6 7h38l-6-7h-26Z" fill="#12332a" /><circle cx="297" cy="215" r="5" fill="#12332a" stroke="#d1f7df" strokeWidth="2" /><circle cx="327" cy="215" r="5" fill="#12332a" stroke="#d1f7df" strokeWidth="2" />
    </svg>
    <div className="public-artwork-labels"><span>გორი</span><span>თბილისი</span></div>
  </div>;
}

export default function BookingPage() {
  const [direction, setDirection] = useState<Direction>('gori-tbilisi');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('');
  const [seats, setSeats] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [goriAddress, setGoriAddress] = useState('');
  const [stopId, setStopId] = useState('');
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [configRetry, setConfigRetry] = useState(0);
  const [slotsRetry, setSlotsRetry] = useState(0);
  const [slotsState, setSlotsState] = useState<SlotState>({ key: '', loading: true, slots: [], error: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const submission = useRef<{ key: string; payload: string } | null>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const slotKey = `${direction}:${date}`;
  const currentSlots = slotsState.key === slotKey ? slotsState.slots.filter(slot => slot.active) : [];
  const loadingSlots = slotsState.key !== slotKey || slotsState.loading;
  const activeStops = config?.stops.filter(stop => stop.active) ?? [];

  useEffect(() => {
    const controller = new AbortController();
    setConfigError('');
    request<PublicConfig>('/public/config', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setConfig(data); })
      .catch(error => { if (!controller.signal.aborted) setConfigError(error instanceof Error ? error.message : 'ინფორმაციის ჩატვირთვა ვერ მოხერხდა.'); });
    return () => controller.abort();
  }, [configRetry]);

  useEffect(() => {
    const controller = new AbortController();
    setSlotsState({ key: slotKey, loading: true, slots: [], error: '' });
    setTime('');
    if (!date || date < today()) {
      setSlotsState({ key: slotKey, loading: false, slots: [], error: '' });
      return () => controller.abort();
    }
    request<{ slots: Slot[] }>(`/public/slots?direction=${direction}&date=${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setSlotsState({ key: slotKey, loading: false, slots: data.slots, error: '' }); })
      .catch(error => {
        if (!controller.signal.aborted) setSlotsState({ key: slotKey, loading: false, slots: [], error: error instanceof Error ? error.message : 'დროების ჩატვირთვა ვერ მოხერხდა.' });
      });
    return () => controller.abort();
  }, [direction, date, slotKey, slotsRetry]);

  useEffect(() => { if (receipt) successHeading.current?.focus(); }, [receipt]);

  function clearError(field: Field) {
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setSubmitError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const nextErrors: Errors = {};
    if (!date || date < today()) nextErrors.date = 'აირჩიეთ დღევანდელი ან მომავალი თარიღი.';
    if (!time || loadingSlots || !currentSlots.some(slot => slot.time === time)) nextErrors.time = 'აირჩიეთ მგზავრობის დრო.';
    if (name.trim().length < 2) nextErrors.name = 'მიუთითეთ თქვენი სახელი.';
    const phoneDigits = phone.replace(/\D/g, '');
    if (!/^[+\d\s()-]+$/.test(phone.trim()) || phoneDigits.length < 9 || phoneDigits.length > 15) nextErrors.phone = 'მიუთითეთ სწორი ტელეფონის ნომერი.';
    if (goriAddress.trim().length < 3) nextErrors.goriAddress = 'მიუთითეთ მისამართი გორში.';
    if (direction === 'tbilisi-gori' && !activeStops.some(stop => String(stop.id) === stopId)) nextErrors.stop = 'აირჩიეთ ჩასხდომის ადგილი.';
    setErrors(nextErrors);
    setSubmitError('');
    if (Object.keys(nextErrors).length) {
      requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }
    if (!config) { setSubmitError('მგზავრობის ინფორმაცია ჯერ არ ჩატვირთულა. სცადეთ ხელახლა.'); return; }
    const payload = JSON.stringify({ name: name.trim(), phone: phone.trim(), seats, direction, requestedDate: date, requestedTime: time, goriAddress: goriAddress.trim(), ...(direction === 'tbilisi-gori' ? { pickupStopId: Number(stopId) } : {}) });
    if (!submission.current || submission.current.payload !== payload) submission.current = { key: crypto.randomUUID(), payload };
    setSubmitting(true);
    try {
      await request<{ id: number }>('/bookings', { method: 'POST', headers: { 'Idempotency-Key': submission.current.key }, body: payload });
      setReceipt({ direction, date, time, seats });
      submission.current = null;
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'ჯავშნის გაგზავნა ვერ მოხერხდა. სცადეთ ხელახლა.');
      requestAnimationFrame(() => errorSummary.current?.focus());
    } finally { setSubmitting(false); }
  }

  function startNewBooking() {
    setReceipt(null);
    setDate(today());
    setTime('');
    setSeats(1);
    setName('');
    setPhone('');
    setGoriAddress('');
    setStopId('');
    setErrors({});
    setSubmitError('');
    setSlotsRetry(value => value + 1);
  }

  const fieldError = (field: Field) => errors[field] ? <span className="booking-field-error" id={`booking-${field}-error`}>{errors[field]}</span> : null;

  return <div className="public-page">
    <header className="public-header">
      <a className="public-brand" href="/" aria-label="GreenTaxi — მთავარი გვერდი"><span className="public-brand-icon"><Leaf size={25} strokeWidth={2.2} /></span><span><strong>Green<span>Taxi</span></strong><small>გორი · თბილისი</small></span></a>
      <nav className="public-header-nav" aria-label="მთავარი ნავიგაცია"><a className="public-booking-link" href="#booking">ადგილის დაჯავშნა <ArrowUpRight size={15} /></a><a href="/admin" className="public-admin-link"><LockKeyhole size={15} /><span>თანამშრომლებისთვის</span></a></nav>
    </header>

    <main className="public-main">
      <section className="public-intro" aria-labelledby="public-title">
        <div className="public-route-badge"><span />ორი ქალაქი. ერთი გზა.</div>
        <h1 id="public-title">გორი <span className="public-title-arrow">↔</span><br /><span>თბილისი</span></h1>
        <p className="public-lead">აირჩიეთ თქვენთვის სასურველი დღე და დრო. მგზავრობის დაგეგმვა აქ იწყება.</p>
        <RouteArtwork />

        <div className="public-route-guide">
          <div className="public-route-guide-heading"><Navigation size={17} /><span>როგორ ვმგზავრობთ</span></div>
          <div className="public-route-explanation"><span className="public-guide-dot" /><div><h2>გორი <ArrowRight size={15} /> თბილისი</h2><p>აგიყვანთ თქვენს მისამართზე, გორის ფარგლებში. თბილისში ჩახვალთ დიდუბეში.</p></div></div>
          <div className="public-route-explanation"><span className="public-guide-dot public-guide-dot-outline" /><div><h2>თბილისი <ArrowRight size={15} /> გორი</h2><p>აირჩიეთ ჩასხდომის ადგილი თბილისში. გორში მიგიყვანთ თქვენ მიერ მითითებულ მისამართზე.</p></div></div>
        </div>
        <div className="public-schedule-note"><Clock3 size={17} /><span>მგზავრობა ყოველდღე</span><span className="public-note-divider" /><span>აირჩიეთ თქვენთვის სასურველი დრო</span></div>
      </section>

      <section className="booking-card" id="booking" aria-labelledby="booking-title">
        {receipt ? <div className="booking-success">
          <div className="booking-success-icon"><CheckCircle2 size={42} strokeWidth={1.5} /></div>
          <span className="booking-eyebrow">ერთი ნაბიჯით ახლოს</span>
          <h2 ref={successHeading} tabIndex={-1}>თქვენი განაცხადი მიღებულია</h2>
          <p>განაცხადი გადაეცა ოპერატორს და ელოდება დადასტურებას.</p>
          <div className="booking-success-summary"><div><MapPin size={18} /><span>{directions[receipt.direction]}</span></div><div><CalendarDays size={18} /><span>{dateLabel(receipt.date)}</span><strong>{receipt.time}</strong></div><div><Users size={18} /><span>{receipt.seats} ადგილი</span></div></div>
          <div className="booking-pending-note"><Clock3 size={17} /><span>მგზავრობა დადასტურებული იქნება ოპერატორის მიერ განაცხადის დამუშავების შემდეგ.</span></div>
          <button className="booking-submit" onClick={startNewBooking}>ახალი ჯავშნის შექმნა <ArrowRight size={18} /></button>
        </div> : <>
          <div className="booking-card-top"><div><span className="booking-eyebrow">დაგეგმეთ თქვენი მგზავრობა</span><h2 id="booking-title">დაჯავშნეთ ადგილი</h2></div><span className="booking-top-icon"><ArrowUpRight size={25} /></span></div>
          <p className="booking-card-description">შეავსეთ ფორმა და გამოგვიგზავნეთ განაცხადი.</p>
          {configError && <div className="booking-load-error" role="alert"><span>{configError}</span><button type="button" onClick={() => setConfigRetry(value => value + 1)}>ხელახლა ცდა</button></div>}
          <form onSubmit={submit} noValidate>
            <fieldset className="booking-section" disabled={submitting}>
              <legend className="booking-section-title"><span>01</span>მგზავრობის დეტალები</legend>
              <div className="booking-direction" role="group" aria-label="მიმართულება">
                {(Object.keys(directions) as Direction[]).map(value => <button type="button" key={value} className={direction === value ? 'is-selected' : ''} aria-pressed={direction === value} onClick={() => { if (direction !== value) { setDirection(value); setTime(''); setStopId(''); setErrors({}); setSubmitError(''); } }}><span>{directions[value]}</span>{direction === value && <Check size={15} />}</button>)}
              </div>
              <div className="booking-two-columns">
                <div className="booking-field"><label htmlFor="booking-date">მგზავრობის თარიღი</label><div className="booking-input-icon"><CalendarDays size={17} /><input type="date" id="booking-date" value={date} min={today()} required aria-invalid={!!errors.date} aria-describedby={errors.date ? 'booking-date-error' : undefined} onChange={event => { setDate(event.target.value); setTime(''); clearError('date'); clearError('time'); }} /></div>{fieldError('date')}</div>
                <div className="booking-field"><label htmlFor="booking-seats">ადგილების რაოდენობა</label><div className="booking-input-icon"><Users size={17} /><select id="booking-seats" value={seats} onChange={event => setSeats(Number(event.target.value))}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} ადგილი</option>)}</select></div></div>
              </div>
              <div className="booking-time-field"><div className="booking-time-heading"><span id="booking-time-label">მგზავრობის დრო</span>{time && <span className="booking-selected-time"><Clock3 size={12} />{time}</span>}</div>
                {loadingSlots ? <div className="booking-slots-message" role="status"><LoaderCircle className="booking-spinner" size={17} />დროები იტვირთება…</div> : slotsState.error ? <div className="booking-load-error" role="alert"><span>{slotsState.error}</span><button type="button" onClick={() => setSlotsRetry(value => value + 1)}>ხელახლა ცდა</button></div> : !currentSlots.length ? <div className="booking-slots-message" role="status">ამ თარიღისთვის დროები არ არის ხელმისაწვდომი. აირჩიეთ სხვა დღე.</div> : <div className="booking-times" role="group" aria-labelledby="booking-time-label" aria-describedby={errors.time ? 'booking-time-error' : undefined}>{currentSlots.map(slot => <button type="button" key={slot.time} aria-pressed={time === slot.time} className={time === slot.time ? 'is-selected' : ''} onClick={() => { setTime(slot.time); clearError('time'); }}>{slot.time}</button>)}</div>}
                {fieldError('time')}
              </div>
            </fieldset>

            <fieldset className="booking-section" disabled={submitting}>
              <legend className="booking-section-title"><span>02</span>ჩასხდომა და ჩამოსვლა</legend>
              <div className="booking-location-fields">
                {direction === 'tbilisi-gori' && <div className="booking-field"><label htmlFor="booking-stop">ჩასხდომის ადგილი თბილისში</label><div className="booking-input-icon"><MapPin size={17} /><select id="booking-stop" value={stopId} required aria-invalid={!!errors.stop} aria-describedby={errors.stop ? 'booking-stop-error' : undefined} onChange={event => { setStopId(event.target.value); clearError('stop'); }}><option value="">{!config ? 'იტვირთება…' : 'აირჩიეთ გაჩერება'}</option>{activeStops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}{stop.address ? ` — ${stop.address}` : ''}</option>)}</select></div>{fieldError('stop')}{config && !activeStops.length && <span className="booking-field-help">ჩასხდომის ადგილები ჯერ არ არის მითითებული.</span>}</div>}
                <div className="booking-field"><label htmlFor="booking-gori-address">{direction === 'gori-tbilisi' ? 'ჩასხდომის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'}</label><div className="booking-input-icon"><MapPin size={17} /><input id="booking-gori-address" value={goriAddress} required maxLength={400} placeholder="ქუჩა, სახლის ნომერი ან ორიენტირი" aria-invalid={!!errors.goriAddress} aria-describedby={errors.goriAddress ? 'booking-goriAddress-error' : 'booking-address-help'} onChange={event => { setGoriAddress(event.target.value); clearError('goriAddress'); }} /></div>{fieldError('goriAddress')}<span className="booking-field-help" id="booking-address-help">მისამართი უნდა იყოს ქალაქ გორის ფარგლებში.</span></div>
                {direction === 'gori-tbilisi' && <div className="booking-fixed-location"><span className="booking-fixed-icon"><ArrowDown size={17} /></span><div><span>ჩამოსვლის ადგილი თბილისში</span><strong>{config?.didubeName || 'დიდუბე'}</strong>{config?.didubeAddress && <small>{config.didubeAddress}</small>}</div><span className="booking-fixed-check"><Check size={15} /></span></div>}
              </div>
            </fieldset>

            <fieldset className="booking-section booking-contact-section" disabled={submitting}>
              <legend className="booking-section-title"><span>03</span>თქვენი მონაცემები</legend>
              <div className="booking-two-columns"><div className="booking-field"><label htmlFor="booking-name">სახელი და გვარი</label><input id="booking-name" autoComplete="name" value={name} required maxLength={100} placeholder="თქვენი სახელი" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'booking-name-error' : undefined} onChange={event => { setName(event.target.value); clearError('name'); }} />{fieldError('name')}</div><div className="booking-field"><label htmlFor="booking-phone">ტელეფონის ნომერი</label><div className="booking-input-icon"><Phone size={16} /><input id="booking-phone" type="tel" autoComplete="tel" inputMode="tel" value={phone} required maxLength={24} placeholder="5XX XX XX XX" aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'booking-phone-error' : undefined} onChange={event => { setPhone(event.target.value); clearError('phone'); }} /></div>{fieldError('phone')}</div></div>
            </fieldset>

            {(submitError || Object.values(errors).some(Boolean)) && <div className="booking-submit-error" ref={errorSummary} role="alert" tabIndex={-1}>{submitError || 'გთხოვთ, შეამოწმოთ მონიშნული ველები.'}</div>}
            <button type="submit" className="booking-submit" disabled={submitting || !config || loadingSlots || !currentSlots.length || (direction === 'tbilisi-gori' && !activeStops.length)}>{submitting ? <><LoaderCircle size={18} className="booking-spinner" />იგზავნება…</> : <>ჯავშნის გაგზავნა <ArrowRight size={18} /></>}</button>
            <p className="booking-submit-note"><Clock3 size={13} />განაცხადს ადასტურებს ოპერატორი</p>
          </form>
        </>}
      </section>
    </main>

    <footer className="public-footer"><span>© {new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Tbilisi' }).format(new Date())} GreenTaxi</span><span>გორი <ChevronRight size={13} /> თბილისი <span className="public-footer-dot">·</span> თბილისი <ChevronRight size={13} /> გორი</span><a href="#booking">დაგეგმეთ მგზავრობა <ArrowUpRight size={13} /></a></footer>
  </div>;
}
