import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Banknote, CalendarDays, Check, CheckCircle2, ChevronDown, Clock3, LoaderCircle, MapPin, Menu, Minus, Phone, Plus, UserRound, Users, X } from 'lucide-react';
import { directions, request, today, type Direction, type PublicConfig, type Slot } from '../api';
import { formatPhone, normalizePhone } from '../../shared/phone';
import './public.css';

type Field = 'date' | 'time' | 'name' | 'phone' | 'goriAddress' | 'stop';
type Errors = Partial<Record<Field, string>>;
type Step = 0 | 1 | 2;
type Receipt = { direction: Direction; date: string; time: string; seats: number };
type SlotState = { key: string; loading: boolean; slots: Slot[]; error: string };
const stepNames = ['მგზავრობა', 'მისამართი', 'კონტაქტი'];
const months = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];

function dateLabel(value: string, withYear = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'აირჩიეთ თარიღი';
  const [year, month, day] = value.split('-');
  return `${Number(day)} ${months[Number(month) - 1]}${withYear ? `, ${year}` : ''}`;
}

function BrandLeaves() {
  return <svg className="public-brand-leaves" viewBox="0 0 40 35" aria-hidden="true"><path d="M19 28C3 28 2 17 2 9c12 1 20 5 19 17L7 14l12 14Z" fill="#00533e" /><path d="M20 29C13 13 24 2 38 1c0 13-4 25-16 29L33 7 20 29Z" fill="#9dcc3a" /></svg>;
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
  const [step, setStep] = useState<Step>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [configRetry, setConfigRetry] = useState(0);
  const [slotsRetry, setSlotsRetry] = useState(0);
  const [slotsState, setSlotsState] = useState<SlotState>({ key: '', loading: true, slots: [], error: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const submission = useRef<{ key: string; payload: string } | null>(null);
  const submittingLock = useRef(false);
  const errorSummary = useRef<HTMLDivElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const ticketHeading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const slotKey = `${direction}:${date}`;
  const currentSlots = slotsState.key === slotKey ? slotsState.slots.filter(slot => slot.active) : [];
  const loadingSlots = slotsState.key !== slotKey || slotsState.loading;
  const activeStops = config?.stops.filter(stop => stop.active) ?? [];

  useEffect(() => {
    const controller = new AbortController();
    setConfigLoading(true);
    setConfigError('');
    const timeout = window.setTimeout(() => {
      setConfigError('ინფორმაციის ჩატვირთვას მეტი დრო სჭირდება. სცადეთ ხელახლა.');
      setConfigLoading(false);
      controller.abort();
    }, 15_000);
    request<PublicConfig>('/public/config', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) { setConfig(data); setConfigLoading(false); } })
      .catch(error => { if (!controller.signal.aborted) { setConfigError(error instanceof Error ? error.message : 'ინფორმაციის ჩატვირთვა ვერ მოხერხდა.'); setConfigLoading(false); } })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [configRetry]);

  useEffect(() => {
    const controller = new AbortController();
    setSlotsState({ key: slotKey, loading: true, slots: [], error: '' });
    setTime('');
    if (!date || date < today()) {
      setSlotsState({ key: slotKey, loading: false, slots: [], error: '' });
      return () => controller.abort();
    }
    const timeout = window.setTimeout(() => {
      setSlotsState({ key: slotKey, loading: false, slots: [], error: 'დროების ჩატვირთვას მეტი დრო სჭირდება. სცადეთ ხელახლა.' });
      controller.abort();
    }, 15_000);
    request<{ slots: Slot[] }>(`/public/slots?direction=${direction}&date=${encodeURIComponent(date)}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setSlotsState({ key: slotKey, loading: false, slots: data.slots, error: '' }); })
      .catch(error => {
        if (!controller.signal.aborted) setSlotsState({ key: slotKey, loading: false, slots: [], error: error instanceof Error ? error.message : 'დროების ჩატვირთვა ვერ მოხერხდა.' });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [direction, date, slotKey, slotsRetry]);

  useEffect(() => { if (receipt) successHeading.current?.focus(); }, [receipt]);
  useEffect(() => {
    if (previousStep.current !== step) { previousStep.current = step; ticketHeading.current?.focus(); }
  }, [step]);

  function clearError(field: Field) {
    setErrors(previous => ({ ...previous, [field]: undefined }));
    setSubmitError('');
  }

  function changeStep(value: Step) {
    if (submittingLock.current) return;
    setStep(value);
    setErrors({});
    setSubmitError('');
  }

  function validation(value: Step): Errors {
    const next: Errors = {};
    if (value === 0) {
      if (!date || date < today()) next.date = 'აირჩიეთ დღევანდელი ან მომავალი თარიღი.';
      if (!time || loadingSlots || !currentSlots.some(slot => slot.time === time)) next.time = 'აირჩიეთ მგზავრობის დრო.';
    } else if (value === 1) {
      if (goriAddress.trim().length < 3) next.goriAddress = 'მიუთითეთ მისამართი გორში.';
      if (direction === 'tbilisi-gori' && !activeStops.some(stop => String(stop.id) === stopId)) next.stop = 'აირჩიეთ ჩასხდომის ადგილი.';
    } else {
      if (name.trim().length < 2) next.name = 'მიუთითეთ თქვენი სახელი.';
      if (!normalizePhone(phone)) next.phone = 'მიუთითეთ სწორი ტელეფონის ნომერი.';
    }
    return next;
  }

  function showErrors(next: Errors) {
    setErrors(next);
    setSubmitError('');
    requestAnimationFrame(() => errorSummary.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingLock.current) return;
    if (step < 2) {
      const next = validation(step);
      if (Object.keys(next).length) { showErrors(next); return; }
      if (step === 1 && (!config || configLoading || configError)) {
        setSubmitError('ჩასხდომის ინფორმაცია ჯერ არ ჩატვირთულა. სცადეთ ხელახლა.');
        requestAnimationFrame(() => errorSummary.current?.focus());
        return;
      }
      changeStep((step + 1) as Step);
      return;
    }
    const validations = [validation(0), validation(1), validation(2)];
    const invalidStep = validations.findIndex(value => Object.keys(value).length);
    if (invalidStep !== -1) { setStep(invalidStep as Step); showErrors(validations[invalidStep]); return; }
    if (!config || configLoading || configError) { setSubmitError('მგზავრობის ინფორმაცია ჯერ არ ჩატვირთულა. სცადეთ ხელახლა.'); requestAnimationFrame(() => errorSummary.current?.focus()); return; }
    if (!Number.isInteger(seats) || seats < 1 || seats > 4) { setStep(0); setSubmitError('ადგილების რაოდენობა უნდა იყოს 1-დან 4-მდე.'); requestAnimationFrame(() => errorSummary.current?.focus()); return; }
    const payload = JSON.stringify({ name: name.trim(), phone: normalizePhone(phone), seats, direction, requestedDate: date, requestedTime: time, goriAddress: goriAddress.trim(), ...(direction === 'tbilisi-gori' ? { pickupStopId: Number(stopId) } : {}) });
    if (!submission.current || submission.current.payload !== payload) submission.current = { key: crypto.randomUUID(), payload };
    submittingLock.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      await request<{ id: number }>('/bookings', { method: 'POST', headers: { 'Idempotency-Key': submission.current.key }, body: payload });
      setReceipt({ direction, date, time, seats });
      submission.current = null;
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'ჯავშნის გაგზავნა ვერ მოხერხდა. სცადეთ ხელახლა.');
      requestAnimationFrame(() => errorSummary.current?.focus());
    } finally { submittingLock.current = false; setSubmitting(false); }
  }

  function startNewBooking() {
    setReceipt(null);
    setStep(0);
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
    requestAnimationFrame(() => ticketHeading.current?.focus());
  }

  const fieldError = (field: Field) => errors[field] ? <span className="booking-field-error" id={`booking-${field}-error`}>{errors[field]}</span> : null;
  const stepError = submitError || Object.values(errors).some(Boolean);

  return <div className="public-page">
    <header className="public-header">
      <a className="public-brand" href="/" aria-label="GreenTaxi — მთავარი გვერდი"><span>Green<strong>Taxi</strong></span><BrandLeaves /></a>
      <button className="public-menu-toggle" type="button" aria-label={menuOpen ? 'მენიუს დახურვა' : 'მენიუს გახსნა'} aria-expanded={menuOpen} aria-controls="public-navigation" onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <X size={23} /> : <Menu size={23} />}</button>
      <nav className={`public-header-nav${menuOpen ? ' is-open' : ''}`} id="public-navigation" aria-label="მთავარი ნავიგაცია">
        <a href="#routes" onClick={() => setMenuOpen(false)}>მარშრუტები</a><a href="#help" onClick={() => setMenuOpen(false)}>დახმარება</a><a href="/admin" className="public-admin-link">თანამშრომლებისთვის <ArrowUpRight size={17} /></a>
      </nav>
    </header>
    <main className="public-main">
      <div className="public-booking-column">
        <section className="public-hero" aria-labelledby="public-title">
          <h1 id="public-title"><span>გორი</span><span className="public-title-arrow" role="img" aria-label="ორივე მიმართულება"><svg viewBox="0 0 110 70" aria-hidden="true"><path d="M8 35H102M33 8 8 35 33 62M77 8 102 35 77 62" fill="none" stroke="currentColor" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span><span>თბილისი</span></h1>
          <div className="public-route-line" aria-hidden="true"><span /><span /></div>
          <p>ერთი მარშრუტი. ორი ქალაქი.</p>
        </section>
        <section className="booking-card" id="booking" aria-labelledby="booking-title">
          {receipt ? <div className="booking-success">
            <CheckCircle2 className="booking-success-icon" size={62} strokeWidth={1.4} />
            <span className="booking-eyebrow">განაცხადი მიღებულია</span>
            <h2 id="booking-title" ref={successHeading} tabIndex={-1}>თქვენი განაცხადი მიღებულია</h2>
            <p>განაცხადი გადაეცა ოპერატორს და ელოდება დადასტურებას.</p>
            <div className="booking-success-summary"><div><MapPin size={20} /><span>{directions[receipt.direction]}</span></div><div><CalendarDays size={20} /><span>{dateLabel(receipt.date, true)}</span><strong>{receipt.time}</strong></div><div><Users size={20} /><span>{receipt.seats} ადგილი</span></div></div>
            <p className="booking-pending-note"><Clock3 size={20} /><span>მგზავრობა დადასტურებული იქნება ოპერატორის მიერ განაცხადის დამუშავების შემდეგ.</span></p>
            <button className="booking-submit" type="button" onClick={startNewBooking}>ახალი ჯავშნის შექმნა <ArrowRight size={22} /></button>
          </div> : <>
            <div className="booking-card-top"><h2 id="booking-title" ref={ticketHeading} tabIndex={-1}>დაჯავშნე მგზავრობა<span className="booking-sr-only"> — {stepNames[step]}</span></h2><span className="booking-step-counter" aria-hidden="true"><strong>0{step + 1}</strong><span>/ 03</span></span></div>
            <ol className="booking-progress" aria-label="დაჯავშნის ეტაპები">{stepNames.map((label, index) => <li key={label} className={index === step ? 'is-current' : index < step ? 'is-complete' : ''} aria-current={index === step ? 'step' : undefined}><button type="button" aria-label={label} disabled={index > step || submitting} onClick={() => changeStep(index as Step)}><span className="booking-progress-number" aria-hidden="true">{index < step ? <Check size={17} /> : index + 1}</span><span>{label}</span></button></li>)}</ol>
            {configError && <div className="booking-load-error" role="alert"><span>{configError}</span><button type="button" disabled={configLoading} onClick={() => setConfigRetry(value => value + 1)}>ხელახლა ცდა</button></div>}
            <form className="booking-form" onSubmit={submit} noValidate aria-busy={submitting}>
              <fieldset className="booking-step" disabled={submitting}>
                <legend className="booking-sr-only">{stepNames[step]}</legend>
                {step === 0 ? <>
                  <div className="booking-direction" role="group" aria-label="მიმართულება">{(Object.keys(directions) as Direction[]).map(value => <button type="button" key={value} className={direction === value ? 'is-selected' : ''} aria-pressed={direction === value} onClick={() => { if (direction !== value) { setDirection(value); setTime(''); setStopId(''); setErrors({}); setSubmitError(''); } }}><span className="booking-direction-radio" aria-hidden="true" /><span>{directions[value]}</span></button>)}</div>
                  <div className="booking-two-columns booking-journey-fields">
                    <div className="booking-field"><label htmlFor="booking-date">თარიღი</label><div className="booking-date-control"><CalendarDays size={24} /><span aria-hidden="true">{dateLabel(date, true)}</span><ChevronDown className="booking-date-chevron" size={19} /><input type="date" id="booking-date" aria-label="მგზავრობის თარიღი" value={date} min={today()} required aria-invalid={!!errors.date} aria-describedby={errors.date ? 'booking-date-error' : undefined} onClick={event => { try { event.currentTarget.showPicker?.(); } catch { /* The native input remains available in unsupported browsers. */ } }} onChange={event => { setDate(event.target.value); setTime(''); clearError('date'); clearError('time'); }} /></div>{fieldError('date')}</div>
                    <div className="booking-field"><label htmlFor="booking-seats">მგზავრები</label><div className="booking-seat-control"><Users size={24} /><button type="button" aria-label="ადგილების რაოდენობის შემცირება" disabled={seats === 1} onClick={() => setSeats(value => Math.max(1, value - 1))}><Minus size={20} /></button><input id="booking-seats" aria-label="ადგილების რაოდენობა" type="number" inputMode="numeric" value={seats} min={1} max={4} readOnly onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSeats(value => Math.max(1, Math.min(4, value + (event.key === 'ArrowUp' ? 1 : -1)))); } }} /><button type="button" aria-label="ადგილების რაოდენობის გაზრდა" disabled={seats === 4} onClick={() => setSeats(value => Math.min(4, value + 1))}><Plus size={20} /></button><span>მგზავრი</span></div></div>
                  </div>
                  <div className="booking-time-field"><div className="booking-time-heading"><span id="booking-time-label">გასვლის დრო</span><span className="booking-times-count">{!loadingSlots && !slotsState.error && currentSlots.length ? `${currentSlots.length} დრო` : ''}</span></div><span className="booking-sr-only" id="booking-time-help">მეტი დროის სანახავად გადაახვიეთ სია.</span>
                    {loadingSlots ? <div className="booking-slots-message" role="status"><LoaderCircle className="booking-spinner" size={20} />დროები იტვირთება…</div> : slotsState.error ? <div className="booking-load-error booking-slots-error" role="alert"><span>{slotsState.error}</span><button type="button" onClick={() => setSlotsRetry(value => value + 1)}>ხელახლა ცდა</button></div> : !currentSlots.length ? <div className="booking-slots-message" role="status">ამ თარიღისთვის დროები არ არის ხელმისაწვდომი. აირჩიეთ სხვა დღე.</div> : <div className="booking-times" role="group" aria-label="მგზავრობის დრო" aria-describedby={`booking-time-help${errors.time ? ' booking-time-error' : ''}`}>{currentSlots.map(slot => <button type="button" key={slot.time} aria-pressed={time === slot.time} className={time === slot.time ? 'is-selected' : ''} onClick={() => { setTime(slot.time); clearError('time'); }}><span>{slot.time}</span>{time === slot.time && <Check size={19} />}</button>)}</div>}
                    {fieldError('time')}
                  </div>
                </> : <>
                  <div className="booking-detail-heading"><h3>{step === 1 ? 'ჩასხდომა და ჩამოსვლა' : 'თქვენი მონაცემები'}</h3><button type="button" className="booking-back" onClick={() => changeStep((step - 1) as Step)}><ArrowLeft size={18} />უკან</button></div>
                  {step === 1 ? <div className="booking-location-fields">
                    {direction === 'tbilisi-gori' && <div className="booking-field"><label htmlFor="booking-stop">ჩასხდომის ადგილი თბილისში</label><div className="booking-input-icon"><MapPin size={21} /><select id="booking-stop" value={stopId} required disabled={configLoading || !activeStops.length} aria-invalid={!!errors.stop} aria-describedby={errors.stop ? 'booking-stop-error' : undefined} onChange={event => { setStopId(event.target.value); clearError('stop'); }}><option value="">{configLoading ? 'იტვირთება…' : 'აირჩიეთ გაჩერება'}</option>{activeStops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}{stop.address ? ` — ${stop.address}` : ''}</option>)}</select></div>{fieldError('stop')}{config && !activeStops.length && <span className="booking-field-help">ჩასხდომის ადგილები ჯერ არ არის მითითებული.</span>}</div>}
                    <div className="booking-field"><label htmlFor="booking-gori-address">{direction === 'gori-tbilisi' ? 'ჩასხდომის მისამართი გორში' : 'ჩამოსვლის მისამართი გორში'}</label><div className="booking-input-icon"><MapPin size={21} /><input id="booking-gori-address" autoComplete="street-address" value={goriAddress} required maxLength={400} placeholder="ქუჩა, სახლის ნომერი ან ორიენტირი" aria-invalid={!!errors.goriAddress} aria-describedby={errors.goriAddress ? 'booking-goriAddress-error booking-address-help' : 'booking-address-help'} onChange={event => { setGoriAddress(event.target.value); clearError('goriAddress'); }} /></div>{fieldError('goriAddress')}<span className="booking-field-help" id="booking-address-help">მისამართი უნდა იყოს ქალაქ გორის ფარგლებში.</span></div>
                    {direction === 'gori-tbilisi' && <div className="booking-fixed-location"><span className="booking-fixed-icon"><ArrowDown size={21} /></span><div><span>ჩამოსვლის ადგილი თბილისში</span><strong>{configLoading ? 'იტვირთება…' : config?.didubeName || 'დიდუბე'}</strong>{!configLoading && config?.didubeAddress && <small>{config.didubeAddress}</small>}</div><Check size={20} /></div>}
                  </div> : <div className="booking-contact-fields"><p>მიუთითეთ მონაცემები, რომ ოპერატორმა თქვენი განაცხადი დაამუშაოს.</p><div className="booking-two-columns"><div className="booking-field"><label htmlFor="booking-name">სახელი და გვარი</label><input id="booking-name" autoComplete="name" value={name} required maxLength={100} placeholder="თქვენი სახელი" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'booking-name-error' : undefined} onChange={event => { setName(event.target.value); clearError('name'); }} />{fieldError('name')}</div><div className="booking-field"><label htmlFor="booking-phone">ტელეფონის ნომერი</label><div className="booking-input-icon"><Phone size={21} /><input id="booking-phone" type="tel" autoComplete="tel-national" inputMode="tel" value={phone} required maxLength={24} placeholder="5XX XX XX XX" aria-invalid={!!errors.phone} aria-describedby={errors.phone ? 'booking-phone-error' : undefined} onChange={event => { setPhone(event.target.value); clearError('phone'); }} onBlur={event => setPhone(formatPhone(event.target.value))} /></div>{fieldError('phone')}</div></div><div className="booking-contact-note"><Clock3 size={22} /><p>განაცხადის გაგზავნის შემდეგ ჯავშანი ელოდება ოპერატორის დადასტურებას.</p></div></div>}
                </>}
              </fieldset>
              {stepError && <div className="booking-submit-error" ref={errorSummary} role="alert" tabIndex={-1}>{submitError || 'გთხოვთ, შეამოწმოთ მონიშნული ველები.'}</div>}
              <div className="booking-ticket-footer"><div className="booking-summary"><span><CalendarDays size={24} />{dateLabel(date)}</span><span><Clock3 size={24} />{time || 'აირჩიეთ დრო'}</span><span><UserRound size={24} />{seats} მგზავრი</span></div><button type="submit" className={`booking-submit${step === 2 ? ' booking-submit-final' : ''}`} disabled={submitting || (step === 0 && loadingSlots) || (step === 1 && configLoading)}>{submitting ? <><LoaderCircle size={20} className="booking-spinner" />იგზავნება…</> : <>{step === 2 ? 'ჯავშნის გაგზავნა' : 'გაგრძელება'}<ArrowRight size={24} /></>}</button></div>
            </form>
          </>}
        </section>
      </div>
      <aside className="public-information">
        <section className="public-routes" id="routes" aria-labelledby="public-routes-title"><h2 id="public-routes-title">მგზავრობა<br />იწყება აქ</h2><p className="public-routes-intro">აირჩიე სასურველი დრო და დაჯავშნე ადგილი.</p><div className="public-route-explanation"><h3>გორი <ArrowRight size={24} /> თბილისი</h3><p>გორში აგიყვანთ მითითებული მისამართიდან.</p></div><div className="public-route-explanation"><h3>თბილისი <ArrowRight size={24} /> გორი</h3><p>თბილისში ჩასხდომა მითითებულ გაჩერებებზე.</p></div></section>
        <section className="public-help" id="help" aria-labelledby="public-help-title"><h2 id="public-help-title">როგორ მუშაობს <ChevronDown size={17} aria-hidden="true" /></h2><ol className="public-help-steps"><li><span>1</span><div><h3>აირჩიე რეისი</h3><p>აირჩიე გამგზავრების მიმართულება, თარიღი და დრო.</p></div></li><li><span>2</span><div><h3>მიუთითე მისამართი</h3><p>მიუთითე ასვლის/ჩამოსვლის მისამართი ან გაჩერება.</p></div></li><li><span>3</span><div><h3>შეავსე საკონტაქტო ინფორმაცია</h3><p>დატოვე შენი სახელი და საკონტაქტო ნომერი.</p></div></li></ol><div className="public-payment-note"><Banknote size={41} strokeWidth={2} /><div><h3>გადახდა ადგილზე</h3><p>მგზავრობის საფასურს ადგილზე გადაიხდით.</p></div></div></section>
      </aside>
    </main>
    <footer className="public-footer"><span>© 2026 GreenTaxi. ყველა უფლება დაცულია.</span><a href="#help">დახმარება <ArrowUpRight size={16} /></a></footer>
  </div>;
}
