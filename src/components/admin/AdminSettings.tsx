import { useEffect, useState } from 'react';
import { AlertCircle, CalendarDays, Check, CheckCircle2, Clock3, Copy, LoaderCircle, MapPin, Pencil, Plus, RotateCcw, Save, ShieldCheck, Smartphone, UserRoundPlus, X } from 'lucide-react';
import { directions, request, today, type CallDevice, type Direction, type Schedule, type Stop, type User } from '../../api';
import DriverRoster from './DriverRoster';
import './settings.css';

type Feedback = { kind: 'success' | 'error'; message: string } | null;
type LocationSettings = { didubeName: string; didubeAddress: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.';
const sortTimes = (times: string[]) => [...new Set(times)].sort();

function FeedbackMessage({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  const Icon = feedback.kind === 'success' ? CheckCircle2 : AlertCircle;
  return <div className={`admin-config-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}><Icon size={17} /><span>{feedback.message}</span></div>;
}

function TimeEditor({ times, onChange, id, disabled }: { times: string[]; onChange: (times: string[]) => void; id: string; disabled: boolean }) {
  const [newTime, setNewTime] = useState('');
  function addTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(newTime)) return;
    onChange(sortTimes([...times, newTime]));
    setNewTime('');
  }
  return <div className="admin-config-time-editor">
    <div className="admin-config-times" aria-label="გასვლის დროები">
      {times.map(time => <span className="admin-config-time-chip" key={time}><Clock3 size={13} />{time}<button type="button" aria-label={`${time} საათის ამოღება`} onClick={() => onChange(times.filter(item => item !== time))} disabled={disabled}><X size={13} /></button></span>)}
      {times.length === 0 && <span className="admin-config-empty-time">ამ განრიგში დროები არ არის.</span>}
    </div>
    <div className="admin-config-add-time">
      <label className="admin-config-sr-only" htmlFor={id}>ახალი გასვლის დრო</label>
      <input id={id} type="time" value={newTime} onChange={event => setNewTime(event.target.value)} disabled={disabled} />
      <button type="button" className="admin-config-button secondary" onClick={addTime} disabled={disabled || !newTime || times.includes(newTime)}><Plus size={16} />დროის დამატება</button>
    </div>
  </div>;
}

export default function AdminSettings({ onChange }: { onChange: () => void }) {
  const [direction, setDirection] = useState<Direction>('gori-tbilisi');
  const [date, setDate] = useState(today);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [baseTimes, setBaseTimes] = useState<string[]>([]);
  const [dateTimes, setDateTimes] = useState<string[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleBusy, setScheduleBusy] = useState<'base' | 'date' | 'reset' | null>(null);
  const [scheduleFeedback, setScheduleFeedback] = useState<Feedback>(null);
  const [driverRefresh, setDriverRefresh] = useState(0);
  const [driverBusy, setDriverBusy] = useState(false);
  const [stops, setStops] = useState<Stop[]>([]);
  const [locations, setLocations] = useState<LocationSettings>({ didubeName: '', didubeAddress: '' });
  const [stopDraft, setStopDraft] = useState({ name: '', address: '' });
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const [locationBusy, setLocationBusy] = useState<string | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [locationFeedback, setLocationFeedback] = useState<Feedback>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [staffDraft, setStaffDraft] = useState({ name: '', login: '', password: '' });
  const [staffBusy, setStaffBusy] = useState(false);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffFeedback, setStaffFeedback] = useState<Feedback>(null);
  const [devices, setDevices] = useState<CallDevice[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [deviceBusy, setDeviceBusy] = useState<number | 'create' | null>(null);
  const [deviceFeedback, setDeviceFeedback] = useState<Feedback>(null);
  const [pairing, setPairing] = useState<{ device: CallDevice; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const callEndpoint = window.location.origin;

  async function fetchSchedule(selectedDirection = direction, selectedDate = date) {
    const result = await request<Schedule>(`/admin/schedule?direction=${selectedDirection}&date=${selectedDate}`);
    setSchedule(result);
    setBaseTimes(result.baseTimes);
    setDateTimes(result.overrideTimes ?? result.baseTimes);
  }

  useEffect(() => {
    let active = true;
    setScheduleLoading(true);
    setSchedule(null);
    setScheduleFeedback(null);
    request<Schedule>(`/admin/schedule?direction=${direction}&date=${date}`).then(result => {
      if (!active) return;
      setSchedule(result);
      setBaseTimes(result.baseTimes);
      setDateTimes(result.overrideTimes ?? result.baseTimes);
    }).catch(error => { if (active) setScheduleFeedback({ kind: 'error', message: errorMessage(error) }); })
      .finally(() => { if (active) setScheduleLoading(false); });
    return () => { active = false; };
  }, [direction, date]);

  useEffect(() => {
    let active = true;
    Promise.all([request<{ stops: Stop[] }>('/admin/stops'), request<LocationSettings>('/admin/settings')]).then(([stopResult, settingResult]) => {
      if (!active) return;
      setStops(stopResult.stops);
      setLocations(settingResult);
    }).catch(error => { if (active) setLocationFeedback({ kind: 'error', message: errorMessage(error) }); })
      .finally(() => { if (active) setLocationLoading(false); });
    request<{ users: User[] }>('/admin/staff').then(result => { if (active) setUsers(result.users); })
      .catch(error => { if (active) setStaffFeedback({ kind: 'error', message: errorMessage(error) }); })
      .finally(() => { if (active) setStaffLoading(false); });
    request<{ devices: CallDevice[] }>('/admin/devices').then(result => { if (active) setDevices(result.devices); })
      .catch(error => { if (active) setDeviceFeedback({ kind: 'error', message: errorMessage(error) }); })
      .finally(() => { if (active) setDevicesLoading(false); });
    return () => { active = false; };
  }, []);

  async function saveSchedule(kind: 'base' | 'date' | 'reset') {
    setScheduleBusy(kind);
    setScheduleFeedback(null);
    try {
      if (kind === 'reset') {
        await request(`/admin/schedule/date?direction=${direction}&date=${date}`, { method: 'DELETE' });
      } else {
        await request(`/admin/schedule/${kind}`, { method: 'PUT', body: JSON.stringify(kind === 'base' ? { direction, times: baseTimes } : { direction, date, times: dateTimes }) });
      }
      setDriverRefresh(value => value + 1);
      await fetchSchedule();
      onChange();
      setScheduleFeedback({ kind: 'success', message: kind === 'reset' ? 'ამ თარიღისთვის ყოველდღიური განრიგი აღდგენილია.' : 'განრიგი შენახულია.' });
    } catch (error) { setScheduleFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setScheduleBusy(null); }
  }

  async function saveStop() {
    const draft = editingStop ?? stopDraft;
    if (draft.name.trim().length < 2 || draft.address.trim().length < 3) return;
    setLocationBusy('stop');
    setLocationFeedback(null);
    try {
      await request(editingStop ? `/admin/stops/${editingStop.id}` : '/admin/stops', { method: editingStop ? 'PATCH' : 'POST', body: JSON.stringify({ name: draft.name.trim(), address: draft.address.trim(), ...(editingStop ? { active: editingStop.active } : {}) }) });
      const result = await request<{ stops: Stop[] }>('/admin/stops');
      setStops(result.stops);
      setStopDraft({ name: '', address: '' });
      setEditingStop(null);
      onChange();
      setLocationFeedback({ kind: 'success', message: 'ჩასხდომის პუნქტი შენახულია.' });
    } catch (error) { setLocationFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setLocationBusy(null); }
  }

  async function toggleStop(stop: Stop) {
    setLocationBusy(`toggle-${stop.id}`);
    setLocationFeedback(null);
    try {
      await request(`/admin/stops/${stop.id}`, { method: 'PATCH', body: JSON.stringify({ name: stop.name, address: stop.address, active: !stop.active }) });
      const result = await request<{ stops: Stop[] }>('/admin/stops');
      setStops(result.stops);
      onChange();
      setLocationFeedback({ kind: 'success', message: stop.active ? 'პუნქტი გამორთულია ახალი ჯავშნებისთვის.' : 'პუნქტი ჩართულია ახალი ჯავშნებისთვის.' });
    } catch (error) { setLocationFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setLocationBusy(null); }
  }

  async function saveDidube() {
    if (locations.didubeName.trim().length < 2 || locations.didubeAddress.trim().length < 3) return;
    setLocationBusy('didube');
    setLocationFeedback(null);
    try {
      await request('/admin/settings', { method: 'PUT', body: JSON.stringify({ didubeName: locations.didubeName.trim(), didubeAddress: locations.didubeAddress.trim() }) });
      onChange();
      setLocationFeedback({ kind: 'success', message: 'დიდუბის მისამართი შენახულია.' });
    } catch (error) { setLocationFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setLocationBusy(null); }
  }

  async function addStaff(event: React.FormEvent) {
    event.preventDefault();
    setStaffBusy(true);
    setStaffFeedback(null);
    try {
      await request('/admin/staff', { method: 'POST', body: JSON.stringify({ login: staffDraft.login.trim(), name: staffDraft.name.trim(), password: staffDraft.password }) });
      const result = await request<{ users: User[] }>('/admin/staff');
      setUsers(result.users);
      setStaffDraft({ name: '', login: '', password: '' });
      onChange();
      setStaffFeedback({ kind: 'success', message: 'თანამშრომელი დამატებულია.' });
    } catch (error) { setStaffFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setStaffBusy(false); }
  }

  async function pairDevice(event: React.FormEvent) {
    event.preventDefault();
    if (deviceName.trim().length < 2) return;
    setDeviceBusy('create');
    setDeviceFeedback(null);
    setCopied(false);
    try {
      const result = await request<{ device: CallDevice; token: string }>('/admin/devices', {
        method: 'POST', body: JSON.stringify({ name: deviceName.trim() }),
      });
      setDevices(previous => [result.device, ...previous]);
      setPairing(result);
      setDeviceName('');
      onChange();
    } catch (error) { setDeviceFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setDeviceBusy(null); }
  }

  async function revokeDevice(device: CallDevice) {
    setDeviceBusy(device.id);
    setDeviceFeedback(null);
    try {
      await request(`/admin/devices/${device.id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) });
      setDevices(previous => previous.map(item => item.id === device.id ? { ...item, active: false } : item));
      if (pairing?.device.id === device.id) setPairing(null);
      onChange();
      setDeviceFeedback({ kind: 'success', message: 'ტელეფონის წვდომა გაუქმებულია. ამ მოწყობილობიდან ზარები აღარ მიიღება.' });
    } catch (error) { setDeviceFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setDeviceBusy(null); }
  }

  async function refreshDevices() {
    setDevicesLoading(true);
    setDeviceFeedback(null);
    try {
      const result = await request<{ devices: CallDevice[] }>('/admin/devices');
      setDevices(result.devices);
    } catch (error) { setDeviceFeedback({ kind: 'error', message: errorMessage(error) }); }
    finally { setDevicesLoading(false); }
  }

  async function copyPairingToken() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.token);
      setCopied(true);
    } catch {
      setDeviceFeedback({ kind: 'error', message: 'კოპირება ვერ მოხერხდა. მონიშნეთ კოდი და დააკოპირეთ ხელით.' });
    }
  }

  function deviceLastSeen(value: string | null) {
    if (!value) return 'ჯერ არ დაკავშირებულა';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const part = (type: string) => parts.find(item => item.type === type)?.value || '';
    return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
  }

  const disabledWithOrders = schedule?.slots.filter(slot => !slot.active && slot.bookingCount > 0) ?? [];
  const proposedRemoved = schedule?.slots.filter(slot => slot.active && slot.bookingCount > 0 && !dateTimes.includes(slot.time)) ?? [];
  const changedBaseWithOrders = schedule?.overrideTimes === null ? schedule.slots.filter(slot => slot.active && slot.bookingCount > 0 && !baseTimes.includes(slot.time)) : [];
  const locationDraft = editingStop ?? stopDraft;
  const loadingIcon = <LoaderCircle className="admin-config-spinner" size={17} />;

  return <div className="admin-settings">
    <section className="admin-config-card admin-config-schedule">
      <div className="admin-config-heading"><div className="admin-config-icon"><CalendarDays size={23} /></div><div><h2>მგზავრობის განრიგი</h2><p>ყოველდღიური დროები და გამონაკლისები კონკრეტული თარიღისთვის.</p></div></div>
      <div className="admin-config-schedule-filters"><label>მიმართულება<select aria-label="მიმართულება" value={direction} onChange={event => setDirection(event.target.value as Direction)} disabled={!!scheduleBusy}>{Object.entries(directions).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>თარიღი<input type="date" aria-label="თარიღი" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} disabled={!!scheduleBusy} /></label></div>
      <FeedbackMessage feedback={scheduleFeedback} />
      {scheduleLoading ? <div className="admin-config-loading">{loadingIcon}განრიგი იტვირთება…</div> : schedule ? <>
        <div className="admin-config-schedule-columns">
          <div className="admin-config-subsection"><div className="admin-config-section-label"><span className="admin-config-eyebrow">ყოველდღიური განრიგი</span><span className="admin-config-counter">{baseTimes.length} დრო</span></div><p>მოქმედებს ყველა დღეზე, რომელსაც საკუთარი განრიგი არ აქვს.</p><TimeEditor times={baseTimes} onChange={setBaseTimes} id="base-new-time" disabled={!!scheduleBusy || driverBusy} />{changedBaseWithOrders && changedBaseWithOrders.length > 0 && <div className="admin-config-warning"><AlertCircle size={17} /><span>ამ დროებზე უკვე არის ჯავშნები: {changedBaseWithOrders.map(slot => slot.time).join(', ')}. ისინი შენარჩუნდება და გადატანა დასჭირდება.</span></div>}<button type="button" className="admin-config-button primary" disabled={!!scheduleBusy || driverBusy} onClick={() => saveSchedule('base')}>{scheduleBusy === 'base' ? loadingIcon : <Save size={16} />}ყოველდღიური განრიგის შენახვა</button></div>
          <div className="admin-config-subsection"><div className="admin-config-section-label"><span className="admin-config-eyebrow">არჩეული თარიღი</span><span className={`admin-config-status ${schedule.overrideTimes ? 'custom' : ''}`}>{schedule.overrideTimes ? 'ინდივიდუალური' : 'ყოველდღიური'}</span></div><p>ცვლილება მხოლოდ {date} თარიღზე იმოქმედებს.</p><TimeEditor times={dateTimes} onChange={setDateTimes} id="date-new-time" disabled={!!scheduleBusy || driverBusy} />{proposedRemoved.length > 0 && <div className="admin-config-warning"><AlertCircle size={17} /><span>ამ დროებზე უკვე არის ჯავშნები: {proposedRemoved.map(slot => slot.time).join(', ')}. ისინი შენარჩუნდება და გადატანა დასჭირდება.</span></div>}<div className="admin-config-actions"><button type="button" className="admin-config-button primary" disabled={!!scheduleBusy || driverBusy} onClick={() => saveSchedule('date')}>{scheduleBusy === 'date' ? loadingIcon : <Save size={16} />}ამ დღის შენახვა</button><button type="button" className="admin-config-button secondary" disabled={!!scheduleBusy || driverBusy || schedule.overrideTimes === null} onClick={() => saveSchedule('reset')}>{scheduleBusy === 'reset' ? loadingIcon : <RotateCcw size={16} />}აღდგენა</button></div></div>
        </div>
        {disabledWithOrders.length > 0 && <div className="admin-config-warning"><AlertCircle size={18} /><span>გამორთულ დროებზე დარჩენილია ჯავშნები: {disabledWithOrders.map(slot => `${slot.time} (${slot.bookingCount})`).join(', ')}. გადაიტანეთ ისინი მოქმედ დროზე ჯავშნების გვერდიდან.</span></div>}
        <div className="admin-config-footnote"><ShieldCheck size={16} />განრიგის შეცვლა არსებულ ჯავშნებს არ წაშლის.</div>
      </> : null}
      <DriverRoster direction={direction} date={date} refreshKey={driverRefresh} disabled={!!scheduleBusy} onBusyChange={setDriverBusy} onChange={onChange} />
    </section>

    <section className="admin-config-card admin-config-locations">
      <div className="admin-config-heading"><div className="admin-config-icon"><MapPin size={23} /></div><div><h2>ჩასხდომა და ჩამოსვლა</h2><p>მართეთ თბილისის პუნქტები და დიდუბის მისამართი.</p></div></div>
      <FeedbackMessage feedback={locationFeedback} />
      {locationLoading ? <div className="admin-config-loading">{loadingIcon}პუნქტები იტვირთება…</div> : <>
        <div className="admin-config-note"><AlertCircle size={17} /><span>საწყისი პუნქტები სატესტოა. მგზავრებისთვის გახსნამდე მიუთითეთ ზუსტი სახელები და მისამართები.</span></div>
        <div className="admin-config-location-columns"><div className="admin-config-subsection"><div className="admin-config-section-label"><span className="admin-config-eyebrow">თბილისი → გორი</span><span className="admin-config-counter">{stops.filter(stop => stop.active).length} აქტიური პუნქტი</span></div><p>მგზავრი ჩასხდომისთვის ერთ-ერთ აქტიურ პუნქტს ირჩევს.</p><div className="admin-config-stop-list">{stops.map(stop => <div className={`admin-config-stop ${stop.active ? '' : 'inactive'}`} key={stop.id}><div className="admin-config-stop-pin"><MapPin size={17} /></div><div className="admin-config-stop-info"><strong>{stop.name}</strong><span>{stop.address}</span>{!stop.active && <small>გამორთულია</small>}</div><button type="button" className="admin-config-icon-button" aria-label={`${stop.name} — რედაქტირება`} onClick={() => setEditingStop({ ...stop })} disabled={!!locationBusy}><Pencil size={16} /></button><button type="button" className={`admin-config-toggle ${stop.active ? 'on' : ''}`} role="switch" aria-checked={stop.active} aria-label={`${stop.name} — ${stop.active ? 'გამორთვა' : 'ჩართვა'}`} onClick={() => toggleStop(stop)} disabled={!!locationBusy}><span /></button></div>)}{stops.length === 0 && <div className="admin-config-empty">ჩასხდომის პუნქტები ჯერ არ არის. დაამატეთ პირველი პუნქტი.</div>}</div>
          <div className="admin-config-stop-form"><div className="admin-config-section-label"><strong>{editingStop ? 'პუნქტის რედაქტირება' : 'ახალი პუნქტი'}</strong>{editingStop && <button type="button" className="admin-config-icon-button" aria-label="რედაქტირების დახურვა" onClick={() => setEditingStop(null)} disabled={!!locationBusy}><X size={16} /></button>}</div><label>პუნქტის სახელი<input value={locationDraft.name} placeholder="მაგ. ჩასხდომის პუნქტი" onChange={event => editingStop ? setEditingStop({ ...editingStop, name: event.target.value }) : setStopDraft({ ...stopDraft, name: event.target.value })} maxLength={120} disabled={!!locationBusy} /></label><label>ზუსტი მისამართი<input value={locationDraft.address} placeholder="ქუჩა, ნომერი ან ორიენტირი" onChange={event => editingStop ? setEditingStop({ ...editingStop, address: event.target.value }) : setStopDraft({ ...stopDraft, address: event.target.value })} maxLength={500} disabled={!!locationBusy} /></label><button type="button" className="admin-config-button primary" onClick={saveStop} disabled={!!locationBusy || locationDraft.name.trim().length < 2 || locationDraft.address.trim().length < 3}>{locationBusy === 'stop' ? loadingIcon : editingStop ? <Check size={16} /> : <Plus size={16} />}{editingStop ? 'ცვლილებების შენახვა' : 'პუნქტის დამატება'}</button></div>
        </div><div className="admin-config-subsection admin-config-didube"><span className="admin-config-eyebrow">გორი → თბილისი</span><h3>დიდუბის ჩამოსვლის პუნქტი</h3><p>თბილისში ყველა მგზავრი ამ ერთ პუნქტში ჩამოდის. გორში მისამართს თავად მიუთითებს.</p><label>პუნქტის სახელი<input value={locations.didubeName} onChange={event => setLocations({ ...locations, didubeName: event.target.value })} maxLength={120} disabled={!!locationBusy} /></label><label>ზუსტი მისამართი<textarea rows={3} value={locations.didubeAddress} onChange={event => setLocations({ ...locations, didubeAddress: event.target.value })} placeholder="მიუთითეთ დიდუბის ზუსტი მისამართი" maxLength={500} disabled={!!locationBusy} /></label><button type="button" className="admin-config-button primary" onClick={saveDidube} disabled={!!locationBusy || locations.didubeName.trim().length < 2 || locations.didubeAddress.trim().length < 3}>{locationBusy === 'didube' ? loadingIcon : <Save size={16} />}მისამართის შენახვა</button><div className="admin-config-route-note"><MapPin size={17} /><span>გორში ჩასხდომა და ჩამოსვლა ხდება მგზავრის მიერ მითითებულ მისამართზე, ქალაქის ფარგლებში.</span></div></div></div>
      </>}
    </section>

    <section className="admin-config-card admin-config-devices">
      <div className="admin-config-heading"><div className="admin-config-icon"><Smartphone size={23} /></div><div><h2>ტელეფონის დაკავშირება</h2><p>პასუხგაცემული შემომავალი SIM ზარები ოპერატორის Android ტელეფონიდან.</p></div></div>
      <FeedbackMessage feedback={deviceFeedback} />
      <div className="admin-config-device-columns">
        <div>
          <div className="admin-config-section-label"><span className="admin-config-eyebrow">დაკავშირებული ტელეფონები</span><div className="admin-config-actions"><span className="admin-config-counter">{devices.filter(device => device.active).length} აქტიური</span><button type="button" className="admin-config-icon-button" aria-label="ტელეფონების ბოლო კავშირის განახლება" onClick={refreshDevices} disabled={devicesLoading || deviceBusy !== null}><RotateCcw size={15} /></button></div></div>
          {devicesLoading ? <div className="admin-config-loading">{loadingIcon}მოწყობილობები იტვირთება…</div> : <div className="admin-config-device-list">
            {devices.map(device => <div className={`admin-config-device ${device.active ? '' : 'revoked'}`} key={device.id}>
              <div className="admin-config-device-top"><div className="admin-config-device-icon"><Smartphone size={19} /></div><strong>{device.name}</strong><span className={`admin-config-status ${device.active ? '' : 'revoked'}`}>{device.active ? 'აქტიური' : 'წვდომა გაუქმებულია'}</span></div>
              <p>ბოლო კავშირი: {deviceLastSeen(device.lastSeenAt)}</p>
              {device.active && <button type="button" className="admin-config-button revoke" disabled={deviceBusy !== null} onClick={() => revokeDevice(device)}>{deviceBusy === device.id ? loadingIcon : <X size={15} />}წვდომის გაუქმება</button>}
            </div>)}
            {devices.length === 0 && <div className="admin-config-empty">ტელეფონი ჯერ არ არის დაკავშირებული. შექმენით დაკავშირების კოდი და შეიყვანეთ Android აპში.</div>}
          </div>}
        </div>
        <div className="admin-config-device-setup">
          <h3>Android ტელეფონის დამატება</h3>
          <p>ოპერატორის Redmi ტელეფონზე Android 15-ით დააყენეთ Green Taxi-ის თანმხლები აპი და მიანიჭეთ ზარების ჟურნალის საჭირო წვდომა.</p>
          <div className="admin-config-endpoint"><span>HTTPS მისამართი აპისთვის</span><code>{callEndpoint}</code></div>
          {window.location.protocol !== 'https:' && <div className="admin-config-warning"><AlertCircle size={16} /><span>ტელეფონში შეიყვანეთ გამოქვეყნებული საიტის HTTPS მისამართი. ლოკალური მისამართი სხვა მოწყობილობაზე არ იმუშავებს.</span></div>}
          <form onSubmit={pairDevice} className="admin-config-device-form"><label>ტელეფონის სახელი<input value={deviceName} onChange={event => setDeviceName(event.target.value)} placeholder="მაგ. ოპერატორის Redmi" minLength={2} maxLength={100} required disabled={deviceBusy !== null || pairing !== null} /></label><button type="submit" className="admin-config-button primary" disabled={deviceBusy !== null || pairing !== null || devicesLoading || deviceName.trim().length < 2}>{deviceBusy === 'create' ? loadingIcon : <Plus size={16} />}დაკავშირების კოდის შექმნა</button></form>
          {pairing && <div className="admin-config-pairing" role="status"><div className="admin-config-section-label"><strong>{pairing.device.name} — დაკავშირების კოდი</strong><button type="button" className="admin-config-icon-button" aria-label="დაკავშირების კოდის დახურვა" onClick={() => { setPairing(null); setCopied(false); }}><X size={16} /></button></div><p>კოდი მხოლოდ ახლა გამოჩნდება. შეიყვანეთ ის Android აპში მისამართთან ერთად და შეამოწმეთ კავშირი.</p><code className="admin-config-token">{pairing.token}</code><div className="admin-config-actions"><button type="button" className="admin-config-button secondary" onClick={copyPairingToken}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'დაკოპირებულია' : 'კოდის კოპირება'}</button><button type="button" className="admin-config-button secondary" onClick={() => { setPairing(null); setCopied(false); }}>კოდის დამალვა</button></div></div>}
          <div className="admin-config-route-note"><ShieldCheck size={18} /><span>ინახება მხოლოდ პასუხგაცემული შემომავალი SIM ზარების ნომერი, დრო და ხანგრძლივობა. გამოტოვებული, გამავალი და ინტერნეტზარები არ გადაიგზავნება.</span></div>
        </div>
      </div>
    </section>

    <section className="admin-config-card admin-config-staff">
      <div className="admin-config-heading"><div className="admin-config-icon"><UserRoundPlus size={23} /></div><div><h2>თანამშრომლები</h2><p>დაამატეთ ოპერატორები ადმინისტრაციის პანელში.</p></div></div>
      <FeedbackMessage feedback={staffFeedback} />
      <div className="admin-config-staff-columns"><div><div className="admin-config-access-note"><ShieldCheck size={20} /><div><strong>ყველას თანაბარი წვდომა აქვს</strong><p>ყველა თანამშრომელს შეუძლია ჯავშნების, განრიგისა და პარამეტრების მართვა.</p></div></div>{staffLoading ? <div className="admin-config-loading">{loadingIcon}თანამშრომლები იტვირთება…</div> : <div className="admin-config-user-list">{users.map(user => <div className="admin-config-user" key={user.id}><span className="admin-config-avatar">{user.name.charAt(0)}</span><div><strong>{user.name}</strong><span>{user.login}</span></div><span className="admin-config-status">ადმინისტრატორი</span></div>)}</div>}</div><form className="admin-config-staff-form" onSubmit={addStaff}><h3>ახალი თანამშრომელი</h3><label>სახელი<input value={staffDraft.name} onChange={event => setStaffDraft({ ...staffDraft, name: event.target.value })} autoComplete="off" minLength={2} maxLength={100} required disabled={staffBusy} /></label><div className="admin-config-input-row"><label>მომხმარებლის სახელი<input value={staffDraft.login} onChange={event => setStaffDraft({ ...staffDraft, login: event.target.value })} autoComplete="off" spellCheck={false} minLength={3} maxLength={64} pattern="[a-zA-Z0-9_.-]+" required disabled={staffBusy} /></label><label>პაროლი<input type="password" value={staffDraft.password} onChange={event => setStaffDraft({ ...staffDraft, password: event.target.value })} autoComplete="new-password" minLength={10} maxLength={512} required disabled={staffBusy} /></label></div><span className="admin-config-field-help">პაროლი უნდა შეიცავდეს მინიმუმ 10 სიმბოლოს.</span><button type="submit" className="admin-config-button primary" disabled={staffBusy || staffDraft.name.trim().length < 2 || staffDraft.login.trim().length < 3 || staffDraft.password.length < 10}>{staffBusy ? loadingIcon : <UserRoundPlus size={16} />}თანამშრომლის დამატება</button></form></div>
    </section>
  </div>;
}
