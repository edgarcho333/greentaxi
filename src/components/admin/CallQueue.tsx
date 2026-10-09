import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, History, Loader2, Phone, Smartphone, X } from 'lucide-react';
import { ApiError, addDays, request, today, type Booking, type CallInquiry, type Direction, type PassengerProfile, type PublicConfig, type Schedule } from '../../api';
import { formatPhone, normalizePhone, phoneDialNumber } from '../../../shared/phone';
import './call-queue.css';

type Props = { scope: 'incoming' | 'deleted'; search: string; refresh: number; config: PublicConfig; onChange: () => void };
type Draft = {
  phone: string; direction: Direction; goriPickupAddress: string; goriDestinationAddress: string;
  pickupStopId: string; date: string; time: string; seats: number;
  dirty: { phone: boolean; pickup: boolean; destination: boolean; stop: boolean };
};
type ScheduleEntry = { schedule?: Schedule; loading: boolean; loadedAt: number; error?: string };
const callDate = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const shortDate = (value: string) => value.split('-').reverse().slice(0, 2).join('/');
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const profileFor = (call: CallInquiry) => call.phone && call.passengerProfile && normalizePhone(call.phone) !== null && normalizePhone(call.phone) === normalizePhone(call.passengerProfile.phone) ? call.passengerProfile : null;
const scheduleKey = (direction: Direction, date: string) => `${direction}:${date}`;
const futureTime = (date: string, time: string, now: number) => /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) && new Date(`${date}T${time}:00+04:00`).getTime() > now;
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'მოთხოვნა ვერ შესრულდა. სცადეთ ხელახლა.';

function newDraft(call: CallInquiry): Draft {
  const profile = profileFor(call);
  return {
    phone: call.phone ? formatPhone(call.phone) : '', direction: 'gori-tbilisi',
    goriPickupAddress: profile?.goriPickupAddress || '', goriDestinationAddress: profile?.goriAddress || '',
    pickupStopId: profile?.pickupStopId ? String(profile.pickupStopId) : '', date: today(), time: '', seats: 1,
    dirty: { phone: false, pickup: false, destination: false, stop: false },
  };
}
function withProfile(draft: Draft, profile: PassengerProfile | null): Draft {
  const next = {
    ...draft,
    goriPickupAddress: draft.dirty.pickup ? draft.goriPickupAddress : profile?.goriPickupAddress || '',
    goriDestinationAddress: draft.dirty.destination ? draft.goriDestinationAddress : profile?.goriAddress || '',
    pickupStopId: draft.dirty.stop ? draft.pickupStopId : profile?.pickupStopId ? String(profile.pickupStopId) : '',
  };
  return next.goriPickupAddress === draft.goriPickupAddress && next.goriDestinationAddress === draft.goriDestinationAddress && next.pickupStopId === draft.pickupStopId ? draft : next;
}

export default function CallQueue({ scope, search, refresh, config, onChange }: Props) {
  const [callResult, setCallResult] = useState<{ scope: Props['scope']; calls: CallInquiry[] }>({ scope, calls: [] });
  const calls = callResult.scope === scope ? callResult.calls : [];
  const waitingForScope = callResult.scope !== scope;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [schedules, setSchedules] = useState<Record<string, ScheduleEntry>>({});
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [pendingRestore, setPendingRestore] = useState<CallInquiry | null>(null);
  const [restoreError, setRestoreError] = useState('');
  const lockedIds = useRef(new Set<number>());
  const settledIds = useRef(new Map<string, number>());
  const mutationEpoch = useRef(0);
  const scheduleCache = useRef<Record<string, ScheduleEntry>>({});
  const scheduleControllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; scheduleControllers.current.forEach(controller => controller.abort()); }; }, []);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    setLoading(true); setError('');
    const load = () => {
      if (document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true; controller = new AbortController();
      const startedEpoch = mutationEpoch.current;
      const signal = controller.signal;
      return request<{ calls: CallInquiry[] }>(`/admin/calls?${new URLSearchParams({ scope, ...(search ? { search } : {}) })}`, { signal }).then(result => {
        if (!active || signal.aborted) return;
        setCallResult({ scope, calls: result.calls.filter(call => (settledIds.current.get(`${scope}:${call.id}`) || 0) <= startedEpoch) });
        for (const [key, epoch] of settledIds.current) if (key.startsWith(`${scope}:`) && epoch <= startedEpoch) settledIds.current.delete(key);
        setError(''); setNow(Date.now());
      }).catch(cause => { if (active && !signal.aborted) setError(message(cause)); }).finally(() => { inFlight = false; if (active && !signal.aborted) setLoading(false); });
    };
    void load();
    const refreshVisible = () => { setNow(Date.now()); void load(); };
    const timer = scope === 'incoming' ? window.setInterval(refreshVisible, 2_000) : undefined;
    window.addEventListener('focus', refreshVisible); document.addEventListener('visibilitychange', refreshVisible);
    return () => { active = false; controller?.abort(); if (timer) window.clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [scope, search, refresh, version]);
  useEffect(() => { setPage(1); }, [scope, search, pageSize]);
  const pageCount = Math.max(1, Math.ceil(calls.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleCalls = useMemo(() => calls.slice((currentPage - 1) * pageSize, currentPage * pageSize), [calls, currentPage, pageSize]);

  useEffect(() => {
    if (scope !== 'incoming') return;
    setDrafts(previous => {
      let changed = false;
      const next = { ...previous };
      for (const call of visibleCalls) {
        const previousDraft = previous[call.id];
        const existing = previousDraft && !previousDraft.dirty.phone && call.phone && normalizePhone(previousDraft.phone) !== normalizePhone(call.phone) ? { ...previousDraft, phone: formatPhone(call.phone) } : previousDraft;
        const profile = profileFor(call);
        const updated = existing && call.phone && normalizePhone(existing.phone) === normalizePhone(call.phone) ? withProfile(existing, profile) : existing || newDraft(call);
        if (updated !== previousDraft) { next[call.id] = updated; changed = true; }
      }
      return changed ? next : previous;
    });
  }, [visibleCalls, scope]);

  const loadSchedule = useCallback((direction: Direction, date: string, force = false) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const key = scheduleKey(direction, date);
    const cached = scheduleCache.current[key];
    if (cached?.loading || (!force && cached && Date.now() - cached.loadedAt < 30_000)) return;
    const controller = new AbortController();
    scheduleControllers.current.set(key, controller);
    const pending: ScheduleEntry = { ...cached, loading: true, loadedAt: cached?.loadedAt || 0, error: undefined };
    scheduleCache.current[key] = pending; setSchedules(previous => ({ ...previous, [key]: pending }));
    void request<Schedule>(`/admin/schedule?${new URLSearchParams({ direction, date })}`, { signal: controller.signal }).then(schedule => {
      if (!mounted.current || controller.signal.aborted || scheduleControllers.current.get(key) !== controller) return;
      const entry = { schedule, loading: false, loadedAt: Date.now() };
      scheduleCache.current[key] = entry; setSchedules(previous => ({ ...previous, [key]: entry }));
    }).catch(cause => {
      if (!mounted.current || controller.signal.aborted) return;
      const entry = { loading: false, loadedAt: Date.now(), error: message(cause) };
      scheduleCache.current[key] = entry; setSchedules(previous => ({ ...previous, [key]: entry }));
    }).finally(() => { if (scheduleControllers.current.get(key) === controller) scheduleControllers.current.delete(key); });
  }, []);
  useEffect(() => {
    if (scope !== 'incoming') return;
    for (const call of visibleCalls) { const draft = drafts[call.id]; if (draft) loadSchedule(draft.direction, draft.date); }
  }, [scope, visibleCalls, drafts, now, loadSchedule]);
  useEffect(() => {
    if (scope !== 'incoming') return;
    const keys = new Map<string, Draft>();
    for (const call of visibleCalls) { const draft = draftsRef.current[call.id]; if (draft) keys.set(scheduleKey(draft.direction, draft.date), draft); }
    for (const draft of keys.values()) loadSchedule(draft.direction, draft.date, true);
  }, [refresh, version, scope, loadSchedule]);
  useEffect(() => {
    if (scope !== 'incoming') return;
    const currentDay = today();
    setDrafts(previous => {
      let changed = false;
      const next = { ...previous };
      for (const [id, draft] of Object.entries(previous)) {
        if (lockedIds.current.has(Number(id))) continue;
        if (draft.date < currentDay) { next[Number(id)] = { ...draft, date: currentDay, time: '' }; changed = true; }
        else if (draft.time && (!futureTime(draft.date, draft.time, now) || (schedules[scheduleKey(draft.direction, draft.date)]?.schedule && !schedules[scheduleKey(draft.direction, draft.date)].schedule!.slots.some(slot => slot.active && slot.time === draft.time)))) {
          next[Number(id)] = { ...draft, time: '' }; changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [now, schedules, scope]);

  const updateDraft = useCallback((id: number, update: (draft: Draft) => Draft) => {
    if (lockedIds.current.has(id)) return;
    setDrafts(previous => previous[id] ? { ...previous, [id]: update(previous[id]) } : previous);
    setRowErrors(previous => previous[id] ? { ...previous, [id]: '' } : previous);
  }, []);
  const setBusy = (id: number, busy: boolean) => setBusyIds(previous => { const next = new Set(previous); if (busy) next.add(id); else next.delete(id); return next; });
  async function act(call: CallInquiry, action: 'convert' | 'delete' | 'restore') {
    if (lockedIds.current.has(call.id)) return;
    const draft = draftsRef.current[call.id];
    const entry = draft && scheduleCache.current[scheduleKey(draft.direction, draft.date)];
    if (action === 'convert' && (!draft || !validDraft(draft, entry, config, Date.now()))) return;
    lockedIds.current.add(call.id); setBusy(call.id, true); setRowErrors(previous => ({ ...previous, [call.id]: '' })); setRestoreError('');
    try {
      const body = action === 'convert' ? JSON.stringify({
        phone: normalizePhone(draft.phone), seats: draft.seats, direction: draft.direction,
        goriAddress: (draft.direction === 'gori-tbilisi' ? draft.goriPickupAddress : draft.goriDestinationAddress).trim(),
        pickupStopId: draft.direction === 'tbilisi-gori' ? Number(draft.pickupStopId) : null,
        requestedDate: draft.date, requestedTime: draft.time,
      }) : '{}';
      await request<Booking | CallInquiry>(`/admin/calls/${call.id}/${action}`, { method: 'POST', body });
      settledIds.current.set(`${scope}:${call.id}`, ++mutationEpoch.current);
      if (action === 'delete') settledIds.current.delete(`deleted:${call.id}`);
      if (action === 'restore') settledIds.current.delete(`incoming:${call.id}`);
      setCallResult(previous => ({ ...previous, calls: previous.calls.filter(item => item.id !== call.id) }));
      setDrafts(previous => { const next = { ...previous }; delete next[call.id]; return next; });
      if (action === 'restore') setPendingRestore(null);
      setVersion(value => value + 1); onChange();
    } catch (cause) {
      if (action === 'restore') setRestoreError(message(cause));
      else setRowErrors(previous => ({ ...previous, [call.id]: message(cause) }));
      if (action === 'convert' && draft && cause instanceof ApiError && ['SLOT_PAST', 'SLOT_INACTIVE', 'DATE_OUT_OF_RANGE'].includes(cause.code || '')) {
        setDrafts(previous => previous[call.id] ? { ...previous, [call.id]: { ...previous[call.id], time: '' } } : previous);
        loadSchedule(draft.direction, draft.date, true);
      }
    } finally { lockedIds.current.delete(call.id); if (mounted.current) setBusy(call.id, false); }
  }
  useEffect(() => {
    if (!pendingRestore) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !lockedIds.current.has(pendingRestore.id)) setPendingRestore(null); };
    document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close);
  }, [pendingRestore]);
  const restoreBusy = pendingRestore ? busyIds.has(pendingRestore.id) : false;
  const restore = (event: FormEvent) => { event.preventDefault(); if (pendingRestore) void act(pendingRestore, 'restore'); };

  return <section className="admin-table-card admin-calls-card">
    <div className="admin-table-heading"><div><h2><Smartphone size={17} />{scope === 'incoming' ? 'სატელეფონო განაცხადები' : 'წაშლილი სატელეფონო განაცხადები'}<span className="admin-call-count">{calls.length}</span></h2><span>{scope === 'incoming' ? 'აირჩიეთ მისამართი, დღე და დრო · ჯავშანი ავტომატურად დადასტურდება' : 'ზარის აღდგენა მას შემოსულ განაცხადებში დააბრუნებს'}</span></div><button className="admin-text-button" onClick={() => setVersion(value => value + 1)} disabled={loading}>განახლება</button></div>
    {error && <div className="admin-error" role="alert">{error}<button onClick={() => setVersion(value => value + 1)}>ხელახლა ცდა</button></div>}
    {(loading || (waitingForScope && !error)) && !calls.length ? <div className="admin-call-empty"><Loader2 size={18} className="admin-spin" />ზარები იტვირთება…</div> : !calls.length ? <div className="admin-call-empty"><Phone size={17} /><span>{scope === 'incoming' ? 'სატელეფონო განაცხადები ჯერ არ არის. ტელეფონის დაკავშირება შეგიძლიათ პარამეტრებში.' : 'წაშლილი სატელეფონო განაცხადები არ არის.'}</span></div> : <>
      <div className="admin-table-scroll admin-call-table-scroll"><table className={`admin-booking-table admin-calls-table admin-calls-inline-table ${scope === 'deleted' ? 'is-history' : ''}`}><thead><tr><th>ქალაქი</th><th>ტელეფონი</th><th>მისამართი</th><th>ჯავშანი</th><th>ზარი</th><th>მოწყობილობა</th></tr></thead><tbody>{visibleCalls.map(call => {
        const draft = drafts[call.id] || newDraft(call);
        return scope === 'incoming' ? <IncomingCallRow key={call.id} call={call} draft={draft} initialized={!!drafts[call.id]} entry={schedules[scheduleKey(draft.direction, draft.date)]} config={config} now={now} busy={busyIds.has(call.id)} error={rowErrors[call.id] || ''} update={update => updateDraft(call.id, update)} retry={() => { const current = draftsRef.current[call.id]; if (current) loadSchedule(current.direction, current.date, true); }} onConfirm={() => void act(call, 'convert')} onReject={() => void act(call, 'delete')} /> : <HistoryCallRow key={call.id} call={call} busy={busyIds.has(call.id)} onRestore={() => { setPendingRestore(call); setRestoreError(''); }} />;
      })}</tbody></table></div>
      <nav className="admin-pagination admin-call-pagination" aria-label="სატელეფონო განაცხადების გვერდები"><div className="admin-page-buttons"><button className="admin-icon-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} aria-label="წინა გვერდი"><ChevronLeft size={17} /></button><span>{currentPage} / {pageCount}</span><button className="admin-icon-button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} aria-label="შემდეგი გვერდი"><ChevronRight size={17} /></button><span>{(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, calls.length)} / {calls.length}</span></div><label>გვერდზე<select aria-label="ზარები გვერდზე" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}><option>15</option><option>30</option><option>50</option></select></label></nav>
    </>}
    {pendingRestore && <div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !restoreBusy) setPendingRestore(null); }}><section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-call-dialog-title"><header><div><h2 id="admin-call-dialog-title">სატელეფონო განაცხადის აღდგენა</h2><p>{pendingRestore.phone ? formatPhone(pendingRestore.phone) : 'დამალული ნომერი'} · {callDate(pendingRestore.occurredAt)}</p></div><button className="admin-icon-button" disabled={restoreBusy} onClick={() => setPendingRestore(null)} aria-label="დახურვა"><X size={20} /></button></header><form className="admin-booking-form" onSubmit={restore}><p className="admin-call-dialog-copy">ზარი დაბრუნდება შემოსულებში. მგზავრობის მონაცემებს ოპერატორი შეავსებს.</p>{restoreError && <div className="admin-error" role="alert">{restoreError}</div>}<footer className="admin-dialog-footer"><button type="button" className="admin-secondary" disabled={restoreBusy} onClick={() => setPendingRestore(null)}>გაუქმება</button><button className="admin-primary" disabled={restoreBusy}>{restoreBusy && <Loader2 size={16} className="admin-spin" />}აღდგენა</button></footer></form></section></div>}
  </section>;
}

function validDraft(draft: Draft, entry: ScheduleEntry | undefined, config: PublicConfig, now: number) {
  return !!normalizePhone(draft.phone) && draft.seats >= 1 && draft.seats <= 8 &&
    (draft.direction === 'gori-tbilisi' ? draft.goriPickupAddress : draft.goriDestinationAddress).trim().length >= 3 &&
    (draft.direction === 'gori-tbilisi' || config.stops.some(stop => stop.active && stop.id === Number(draft.pickupStopId))) &&
    !!entry?.schedule && !entry.loading && !entry.error && entry.schedule.slots.some(slot => slot.active && slot.time === draft.time) && futureTime(draft.date, draft.time, now);
}

function CallDetails({ call }: { call: CallInquiry }) {
  return <div className={`admin-call-details ${call.phase === 'answered' ? 'is-live' : ''}`}><time dateTime={call.occurredAt}>{callDate(call.occurredAt)}</time><span><i />{call.phase === 'answered' ? 'მიმდინარეობს' : 'დასრულებულია'}{call.phase === 'completed' && <small>{duration(call.durationSeconds)}</small>}</span></div>;
}

function IncomingCallRow({ call, draft, initialized, entry, config, now, busy, error, update, retry, onConfirm, onReject }: {
  call: CallInquiry; draft: Draft; initialized: boolean; entry?: ScheduleEntry; config: PublicConfig; now: number; busy: boolean; error: string;
  update: (updater: (draft: Draft) => Draft) => void; retry: () => void; onConfirm: () => void; onReject: () => void;
}) {
  const timeStrip = useRef<HTMLDivElement>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const currentDay = today();
  const tomorrow = addDays(currentDay, 1);
  const times = entry?.schedule?.slots.filter(slot => slot.active && futureTime(draft.date, slot.time, now)) || [];
  const stops = config.stops.filter(stop => stop.active);
  const normalizedPhone = normalizePhone(draft.phone);
  useEffect(() => {
    if (!initialized || !normalizedPhone || normalizedPhone === normalizePhone(call.phone || '')) { setProfileLoading(false); return; }
    const controller = new AbortController();
    setProfileLoading(true);
    const timer = window.setTimeout(() => {
      void request<{ profile: PassengerProfile | null }>(`/admin/passengers/profile?${new URLSearchParams({ phone: normalizedPhone })}`, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted && (!result.profile || normalizePhone(result.profile.phone) === normalizedPhone)) update(previous => normalizePhone(previous.phone) === normalizedPhone ? withProfile(previous, result.profile) : previous);
      }).catch(() => { /* A profile lookup never blocks entering a new customer's address. */ }).finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [call.phone, normalizedPhone, initialized]);
  useEffect(() => {
    if (!draft.time) { timeStrip.current?.scrollTo({ left: 0 }); return; }
    const selected = timeStrip.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (selected && timeStrip.current) {
      const strip = timeStrip.current;
      if (selected.offsetLeft < strip.scrollLeft || selected.offsetLeft + selected.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: Math.max(0, selected.offsetLeft - strip.clientWidth / 2 + selected.offsetWidth / 2), behavior: 'smooth' });
    }
  }, [draft.direction, draft.date, draft.time]);
  const changePhone = (value: string) => update(previous => {
    const differs = normalizePhone(value) !== normalizePhone(previous.phone);
    return { ...previous, phone: value, dirty: { ...previous.dirty, phone: true }, ...(differs ? {
      goriPickupAddress: previous.dirty.pickup ? previous.goriPickupAddress : '',
      goriDestinationAddress: previous.dirty.destination ? previous.goriDestinationAddress : '',
      pickupStopId: previous.dirty.stop ? previous.pickupStopId : '',
    } : {}) };
  });
  return <tr data-call-id={call.id} data-call-phase={call.phase} aria-busy={busy}>
    <td data-label="ქალაქი" className="admin-call-city"><select aria-label="გამგზავრების ქალაქი" value={draft.direction} disabled={busy || !initialized} onChange={event => update(previous => ({ ...previous, direction: event.target.value as Direction, time: '' }))}><option value="gori-tbilisi">გორი</option><option value="tbilisi-gori">თბილისი</option></select><small>{draft.direction === 'gori-tbilisi' ? '→ თბილისი' : '→ გორი'}</small></td>
    <td data-label="ტელეფონი" className="admin-call-phone-cell"><input aria-label="ტელეფონის ნომერი" type="tel" inputMode="tel" placeholder="568 69 48 79" value={draft.phone} disabled={busy || !initialized} onChange={event => changePhone(event.target.value)} onBlur={() => update(previous => ({ ...previous, phone: normalizePhone(previous.phone) ? formatPhone(previous.phone) : previous.phone }))} /><small>{profileLoading ? 'მისამართი იტვირთება…' : profileFor(call) ? 'მისამართი შენახულია' : call.phone ? 'SIM ზარი' : 'დამალული ნომერი'}</small>{normalizedPhone && <a className="admin-call-dial" href={`tel:${phoneDialNumber(normalizedPhone) || normalizedPhone}`} aria-label={`${formatPhone(normalizedPhone)}: დარეკვა`}><Phone size={11} />დარეკვა</a>}</td>
    <td data-label="მისამართი" className="admin-call-address-cell">{draft.direction === 'gori-tbilisi' ? <textarea aria-label="აყვანის მისამართი გორში" placeholder="ქუჩა, სახლის ნომერი…" maxLength={500} value={draft.goriPickupAddress} disabled={busy || !initialized} onChange={event => update(previous => ({ ...previous, goriPickupAddress: event.target.value, dirty: { ...previous.dirty, pickup: true } }))} /> : <><select aria-label="აყვანის გაჩერება თბილისში" value={draft.pickupStopId} disabled={busy || !initialized} onChange={event => update(previous => ({ ...previous, pickupStopId: event.target.value, dirty: { ...previous.dirty, stop: true } }))}><option value="">აირჩიეთ გაჩერება</option>{stops.map(stop => <option key={stop.id} value={stop.id}>{stop.name}{stop.address ? ` — ${stop.address}` : ''}</option>)}</select><label className="admin-call-destination">ჩამოსვლის მისამართი გორში<textarea aria-label="ჩამოსვლის მისამართი გორში" placeholder="ქუჩა, სახლის ნომერი…" maxLength={500} value={draft.goriDestinationAddress} disabled={busy || !initialized} onChange={event => update(previous => ({ ...previous, goriDestinationAddress: event.target.value, dirty: { ...previous.dirty, destination: true } }))} /></label></>}</td>
    <td data-label="ჯავშანი" className="admin-call-booking-cell"><div className="admin-call-booking-controls">
      <div className="admin-call-day-row" role="group" aria-label="დღე"><button type="button" aria-pressed={draft.date === currentDay} disabled={busy || !initialized} onClick={() => update(previous => ({ ...previous, date: currentDay, time: '' }))}>დღეს<small>{shortDate(currentDay)}</small></button><button type="button" aria-pressed={draft.date === tomorrow} disabled={busy || !initialized} onClick={() => update(previous => ({ ...previous, date: tomorrow, time: '' }))}>ხვალ<small>{shortDate(tomorrow)}</small></button><label className={`admin-call-custom-date ${draft.date !== currentDay && draft.date !== tomorrow ? 'is-selected' : ''}`} title="აირჩიეთ სხვა თარიღი"><CalendarDays size={16} />{draft.date !== currentDay && draft.date !== tomorrow && <span>{shortDate(draft.date)}</span>}<input aria-label="აირჩიეთ სხვა თარიღი" type="date" min={currentDay} value={draft.date} disabled={busy || !initialized} onChange={event => { if (event.target.value >= today()) update(previous => ({ ...previous, date: event.target.value, time: '' })); }} /></label></div>
      <div className="admin-call-time-row"><button type="button" className="admin-call-carousel-arrow" aria-label="წინა საათები" disabled={busy || !times.length} onClick={() => timeStrip.current?.scrollBy({ left: -Math.max(150, timeStrip.current.clientWidth * .8), behavior: 'smooth' })}><ChevronLeft size={15} /></button><div className="admin-call-time-carousel" role="group" aria-label="დრო" ref={timeStrip}>{entry?.error ? <button type="button" className="admin-call-schedule-retry" disabled={busy} onClick={retry}>ხელახლა ცდა</button> : entry?.loading && !entry.schedule ? <span><Loader2 size={13} className="admin-spin" />დრო იტვირთება…</span> : !times.length ? <span>ამ დღისთვის დრო არ არის</span> : times.map(slot => <button type="button" key={slot.time} aria-pressed={draft.time === slot.time} disabled={busy || !initialized || entry?.loading} onClick={() => update(previous => ({ ...previous, time: slot.time }))}>{slot.time}</button>)}</div><button type="button" className="admin-call-carousel-arrow" aria-label="შემდეგი საათები" disabled={busy || !times.length} onClick={() => timeStrip.current?.scrollBy({ left: Math.max(150, timeStrip.current.clientWidth * .8), behavior: 'smooth' })}><ChevronRight size={15} /></button></div>
      <div className="admin-call-bottom-row"><div className="admin-call-seat-group" role="group" aria-label="ადგილების რაოდენობა"><span>ადგილები</span><div>{Array.from({ length: 8 }, (_, index) => index + 1).map(value => <button key={value} type="button" aria-pressed={draft.seats === value} disabled={busy || !initialized} onClick={() => update(previous => ({ ...previous, seats: value }))}>{value}</button>)}</div></div><div className="admin-call-decision"><button type="button" className="admin-call-accept" disabled={busy || !initialized || profileLoading || !validDraft(draft, entry, config, now)} onClick={onConfirm}>{busy ? <Loader2 size={14} className="admin-spin" /> : <Check size={14} />}დადასტურება</button><button type="button" className="admin-call-reject" disabled={busy} onClick={onReject}><X size={14} />უარი</button></div></div>
      {entry?.error && <div className="admin-call-row-error" role="alert">{entry.error}</div>}{error && <div className="admin-call-row-error" role="alert">{error}</div>}
    </div></td>
    <td data-label="ზარი"><CallDetails call={call} /></td><td data-label="მოწყობილობა" className="admin-call-device">{call.deviceName}</td>
  </tr>;
}

function HistoryCallRow({ call, busy, onRestore }: { call: CallInquiry; busy: boolean; onRestore: () => void }) {
  const profile = profileFor(call);
  return <tr data-call-id={call.id} data-call-phase={call.phase}><td data-label="ქალაქი">—</td><td data-label="ტელეფონი" className="admin-call-phone-cell"><strong>{call.phone ? formatPhone(call.phone) : 'დამალული ნომერი'}</strong></td><td data-label="მისამართი" className="admin-call-history-address">{profile?.goriPickupAddress || '—'}{profile?.pickupStopName && <small>თბილისი: {profile.pickupStopName}</small>}</td><td data-label="ჯავშანი"><button className="admin-restore-button" disabled={busy} onClick={onRestore}><History size={14} />აღდგენა</button></td><td data-label="ზარი"><CallDetails call={call} /></td><td data-label="მოწყობილობა" className="admin-call-device">{call.deviceName}</td></tr>;
}
