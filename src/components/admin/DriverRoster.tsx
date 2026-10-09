import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CarFront, Check, CheckCircle2, Clock3, LoaderCircle, RefreshCw, UsersRound, X } from 'lucide-react';
import { request, type Direction, type DriverDay, type DriverSchedule } from '../../api';
import './driver-roster.css';

type Feedback = { kind: 'success' | 'error'; message: string } | null;
type DriverChange = { declined?: boolean; assignment?: { mode: 'auto' } | { mode: 'manual'; time: string | null } };
type Props = {
  direction: Direction;
  date: string;
  refreshKey: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChange: () => void;
};

const dateLabel = (date: string) => date.split('-').reverse().join('/');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'ცვლილება ვერ შეინახა. სცადეთ ხელახლა.';

export default function DriverRoster({ direction, date, refreshKey, disabled, onBusyChange, onChange }: Props) {
  const [schedule, setSchedule] = useState<DriverSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [retry, setRetry] = useState(0);
  const selectionKey = `${direction}/${date}`;
  const selection = useRef(selectionKey);
  selection.current = selectionKey;
  const sequence = useRef(0);
  const mutation = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const currentSequence = ++sequence.current;
    const controller = new AbortController();
    let active = true;
    setSchedule(null);
    setFeedback(null);
    if (direction !== 'gori-tbilisi') {
      setLoading(false);
      return () => { active = false; controller.abort(); };
    }
    setLoading(true);
    request<DriverSchedule>(`/admin/drivers/schedule?direction=${direction}&date=${date}`, { signal: controller.signal })
      .then(result => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey) setSchedule(result);
      })
      .catch(error => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey && !controller.signal.aborted) {
          setFeedback({ kind: 'error', message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (active && sequence.current === currentSequence && selection.current === selectionKey) setLoading(false);
      });
    return () => { active = false; controller.abort(); };
  }, [direction, date, refreshKey, retry, selectionKey]);

  async function changeDriver(driver: DriverDay, change: DriverChange) {
    if (mutation.current || disabled || direction !== 'gori-tbilisi' || !schedule || schedule.date !== date) return;
    mutation.current = true;
    const operationKey = selectionKey;
    setBusyId(driver.id);
    setFeedback(null);
    onBusyChange(true);
    try {
      const result = await request<DriverSchedule>(`/admin/drivers/${driver.id}/day`, {
        method: 'PATCH', body: JSON.stringify({ direction, date, ...change }),
      });
      if (mounted.current && selection.current === operationKey) {
        // A mutation returns the complete recalculated day. Do not let an older read replace it.
        sequence.current++;
        setSchedule(result);
        setLoading(false);
        setFeedback({ kind: 'success', message: 'ამ დღის ცვლილება შენახულია.' });
        onChange();
      }
    } catch (error) {
      if (mounted.current && selection.current === operationKey) setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      mutation.current = false;
      if (mounted.current) {
        setBusyId(null);
        onBusyChange(false);
      }
    }
  }

  function changeTime(driver: DriverDay, value: string) {
    changeDriver(driver, {
      assignment: value === 'auto' ? { mode: 'auto' } : { mode: 'manual', time: value === 'reserve' ? null : value },
    });
  }

  const visibleSchedule = schedule?.direction === direction && schedule.date === date ? schedule : null;
  const firstDriver = visibleSchedule?.drivers.find(driver => driver.id === visibleSchedule.firstDriverId);
  const available = visibleSchedule?.drivers.filter(driver => !driver.declined) ?? [];
  const declinedCount = (visibleSchedule?.drivers.length ?? 0) - available.length;
  const reserveCount = available.filter(driver => !driver.assignedTime).length;
  const saving = busyId !== null;
  const FeedbackIcon = feedback?.kind === 'error' ? AlertCircle : CheckCircle2;

  return <section className="admin-driver-roster" aria-label="მძღოლების რიგი" data-date={visibleSchedule?.date ?? ''}>
    <div className="admin-driver-heading">
      <div className="admin-driver-heading-icon"><CarFront size={23} /></div>
      <div><h3>მძღოლების რიგი</h3><p>გორი → თბილისი · {dateLabel(date)}</p></div>
      {direction === 'gori-tbilisi' && <button type="button" className="admin-driver-refresh" aria-label="მძღოლების რიგის განახლება" onClick={() => setRetry(value => value + 1)} disabled={loading || saving || disabled}><RefreshCw size={17} /></button>}
    </div>
    {direction !== 'gori-tbilisi' ? <div className="admin-driver-direction-note"><CarFront size={19} /><p>მძღოლების რიგი ამ ეტაპზე მოქმედებს მხოლოდ გორი → თბილისი მიმართულებაზე.</p></div> : <>
      {feedback && <div className={`admin-driver-feedback ${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}><FeedbackIcon size={17} /><span>{feedback.message}</span>{feedback.kind === 'error' && !visibleSchedule && <button type="button" onClick={() => setRetry(value => value + 1)} disabled={loading}>ხელახლა ცდა</button>}</div>}
      {loading ? <div className="admin-driver-loading" role="status"><LoaderCircle className="admin-config-spinner" size={18} />მძღოლების რიგი იტვირთება…</div> : visibleSchedule ? <>
        <div className="admin-driver-cycle-info">
          <div><span>დღის რიგი იწყება</span><strong>{firstDriver?.name ?? '—'}</strong></div>
          <div><span>ციკლის დასაწყისი</span><strong>{dateLabel(visibleSchedule.anchorDate)} · რეზო</strong></div>
          <div className="admin-driver-counts"><span><UsersRound size={15} />{available.length} მონაწილეობს</span><span>{declinedCount} უარი</span><span>{reserveCount} რეზერვი</span></div>
        </div>
        <p className="admin-driver-explanation">რიგი ყოველდღე ერთი მძღოლით ინაცვლებს. ამ დღის უარი შემდეგი დღის რიგს არ ცვლის. ერთსა და იმავე დროზე რამდენიმე მძღოლის არჩევა შესაძლებელია.</p>
        {visibleSchedule.times.length === 0 && <div className="admin-driver-empty-times"><AlertCircle size={17} /><span>ამ დღის განრიგში გასვლის დროები არ არის. დაამატეთ და შეინახეთ დროები ზემოთ.</span></div>}
        {visibleSchedule.times.length > 0 && <details className="admin-driver-summary" open>
          <summary><Clock3 size={16} />მძღოლები დროების მიხედვით<span>{visibleSchedule.times.length} დრო</span></summary>
          <div className="admin-driver-slot-grid">{visibleSchedule.times.map(time => {
            const drivers = available.filter(driver => driver.assignmentActive && driver.assignedTime === time);
            return <div className={`admin-driver-slot ${drivers.length ? '' : 'empty'}`} data-driver-slot={time} key={time}>
              <strong>{time}</strong><span>{drivers.length ? drivers.map(driver => driver.name).join(', ') : 'მძღოლი არ არის'}</span>
              <small>{drivers.length} მძღოლი · {drivers.reduce((sum, driver) => sum + driver.capacity, 0)} ადგილი</small>
            </div>;
          })}</div>
        </details>}
        <div className="admin-driver-table-wrap"><table className="admin-driver-table" aria-label="მძღოლები არჩეულ დღეს">
          <thead><tr><th>რიგი</th><th>მძღოლი</th><th>ტევადობა</th><th>გასვლის დრო</th><th>ამ დღის მონაწილეობა</th></tr></thead>
          <tbody>{visibleSchedule.drivers.map(driver => {
            const inactiveTime = driver.assignmentMode === 'manual' && driver.assignedTime !== null && !visibleSchedule.times.includes(driver.assignedTime);
            const selectedTime = driver.declined ? 'declined' : driver.assignmentMode === 'auto' ? 'auto' : driver.assignedTime ?? 'reserve';
            return <tr key={driver.id} data-driver-id={driver.id} className={driver.declined ? 'declined' : ''}>
              <td className="admin-driver-position"><span>{driver.queuePosition}</span></td>
              <td className="admin-driver-name"><strong>{driver.name}</strong>{driver.id === visibleSchedule.firstDriverId && <small>დღის რიგის დასაწყისი</small>}</td>
              <td className="admin-driver-capacity"><span><UsersRound size={14} />{driver.capacity} ადგილი</span></td>
              <td className="admin-driver-time"><select aria-label={`${driver.name} — გასვლის დრო`} value={selectedTime} onChange={event => changeTime(driver, event.target.value)} disabled={saving || disabled || driver.declined}>
                {driver.declined && <option value="declined">ამ დღეს არ მონაწილეობს</option>}
                <option value="auto">ავტომატური — {driver.automaticTime ?? 'რეზერვი'}</option>
                <option value="reserve">რეზერვი — დროის გარეშე</option>
                {visibleSchedule.times.map(time => <option value={time} key={time}>{time}</option>)}
                {inactiveTime && <option value={driver.assignedTime!}>{driver.assignedTime} — გამორთული დრო</option>}
              </select>{inactiveTime && <span className="admin-driver-inactive-time"><AlertCircle size={14} />ეს დრო განრიგში გამორთულია. აირჩიეთ სხვა დრო.</span>}{!driver.declined && driver.assignmentMode === 'manual' && !inactiveTime && <small>ხელით არჩეული · მხოლოდ ამ დღეზე</small>}</td>
              <td className="admin-driver-participation"><button type="button" role="switch" aria-checked={!driver.declined} aria-label={`${driver.name} — მონაწილეობა ამ დღეს`} className={`admin-driver-attendance ${driver.declined ? 'declined' : ''}`} onClick={() => changeDriver(driver, { declined: !driver.declined })} disabled={saving || disabled}>
                {busyId === driver.id ? <LoaderCircle className="admin-config-spinner" size={16} /> : driver.declined ? <X size={16} /> : <Check size={16} />}<span>{driver.declined ? 'უარი ამ დღეზე' : 'მონაწილეობს'}</span>
              </button></td>
            </tr>;
          })}</tbody>
        </table></div>
        {visibleSchedule.drivers.length === 0 && <div className="admin-driver-empty-times">მძღოლები ჯერ არ არის დამატებული.</div>}
        <p className="admin-driver-footnote">დროები ემთხვევა შენახულ განრიგს. ხელით არჩეული დრო ამ დღეზე ინახება; ავტომატური არჩევანი რიგის ცვლილებას მიჰყვება.</p>
      </> : null}
    </>}
  </section>;
}
