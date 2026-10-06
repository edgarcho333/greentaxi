import { useEffect, useState, type FormEvent } from 'react';
import { History, Loader2, Phone, Plus, Smartphone, Trash2, X } from 'lucide-react';
import { request, type CallInquiry } from '../../api';

type Props = { scope: 'incoming' | 'deleted'; search: string; refresh: number; onConvert: (call: CallInquiry) => void; onChange: () => void };
const callDate = (value: string) => new Intl.DateTimeFormat('ka-GE', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function CallQueue({ scope, search, refresh, onConvert, onChange }: Props) {
  const [calls, setCalls] = useState<CallInquiry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ call: CallInquiry; action: 'delete' | 'restore' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const load = () => request<{ calls: CallInquiry[] }>(`/admin/calls?${new URLSearchParams({ scope, ...(search ? { search } : {}) })}`).then(result => { if (active) { setCalls(result.calls); setError(''); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'ზარების ჩატვირთვა ვერ მოხერხდა.'); }).finally(() => { if (active) setLoading(false); });
    void load();
    const timer = scope === 'incoming' ? window.setInterval(() => { void load(); }, 12_000) : undefined;
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [scope, search, refresh, version]);
  useEffect(() => { if (!pending) return; function close(event: KeyboardEvent) { if (event.key === 'Escape' && !busy) setPending(null); } document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close); }, [pending, busy]);
  async function act(event: FormEvent) {
    event.preventDefault(); if (!pending || busy) return;
    setBusy(true); setActionError('');
    try {
      await request<CallInquiry>(`/admin/calls/${pending.call.id}/${pending.action}`, { method: 'POST', body: '{}' });
      setPending(null); setVersion(value => value + 1); onChange();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'მოთხოვნა ვერ შესრულდა.'); }
    finally { setBusy(false); }
  }
  return <section className="admin-table-card admin-calls-card">
    <div className="admin-table-heading"><div><h2><Smartphone size={17} />{scope === 'incoming' ? 'სატელეფონო განაცხადები' : 'წაშლილი სატელეფონო განაცხადები'}<span className="admin-call-count">{calls.length}</span></h2><span>{scope === 'incoming' ? 'პასუხგაცემული შემომავალი SIM ზარები · ავტომატური განახლება' : 'ზარის აღდგენა მას შემოსულ განაცხადებში დააბრუნებს'}</span></div><button className="admin-text-button" onClick={() => setVersion(value => value + 1)} disabled={loading}>განახლება</button></div>
    {error ? <div className="admin-error">{error}<button onClick={() => setVersion(value => value + 1)}>ხელახლა ცდა</button></div> : loading ? <div className="admin-call-empty"><Loader2 size={18} className="admin-spin" />ზარები იტვირთება…</div> : !calls.length ? <div className="admin-call-empty"><Phone size={17} /><span>{scope === 'incoming' ? 'სატელეფონო განაცხადები ჯერ არ არის. ტელეფონის დაკავშირება შეგიძლიათ პარამეტრებში.' : 'წაშლილი სატელეფონო განაცხადები არ არის.'}</span></div> : <div className="admin-table-scroll"><table className="admin-booking-table admin-calls-table"><thead><tr><th>წყარო</th><th>ტელეფონი</th><th>ზარის დრო</th><th>ხანგრძლივობა</th><th>მოწყობილობა</th><th className="admin-actions-heading">მოქმედება</th></tr></thead><tbody>{calls.map(call => <tr key={call.id}><td><span className="admin-call-source"><Phone size={12} /> SIM ზარი</span></td><td><strong>{call.phone || 'დამალული ნომერი'}</strong><small className="admin-cell-subtitle">#{String(call.id).padStart(4, '0')}</small></td><td>{callDate(call.occurredAt)}</td><td>{duration(call.durationSeconds)}</td><td>{call.deviceName}</td><td><div className="admin-row-actions">{scope === 'incoming' ? <><button className="admin-confirm-button" onClick={() => onConvert(call)}><Plus size={14} />ჯავშნის შექმნა</button>{call.phone && <a className="admin-icon-button" href={`tel:${call.phone}`} aria-label={`${call.phone}: დარეკვა`}><Phone size={14} /></a>}<button className="admin-icon-button admin-danger-text" onClick={() => { setPending({ call, action: 'delete' }); setActionError(''); }} aria-label={`${call.phone || 'დამალული ნომერი'}: ზარის წაშლა`}><Trash2 size={14} /></button></> : <button className="admin-restore-button" onClick={() => { setPending({ call, action: 'restore' }); setActionError(''); }}><History size={14} />აღდგენა</button>}</div></td></tr>)}</tbody></table></div>}
    {pending && <div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setPending(null); }}><section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-call-dialog-title"><header><div><h2 id="admin-call-dialog-title">{pending.action === 'delete' ? 'სატელეფონო განაცხადის წაშლა' : 'სატელეფონო განაცხადის აღდგენა'}</h2><p>{pending.call.phone || 'დამალული ნომერი'} · {callDate(pending.call.occurredAt)}</p></div><button className="admin-icon-button" disabled={busy} onClick={() => setPending(null)} aria-label="დახურვა"><X size={20} /></button></header><form className="admin-booking-form" onSubmit={act}><p className="admin-call-dialog-copy">{pending.action === 'delete' ? 'ზარი ისტორიაში გადავა და მისი აღდგენა შესაძლებელი იქნება.' : 'ზარი დაბრუნდება შემოსულებში. მგზავრობის მონაცემებს ოპერატორი ჯავშნის შექმნისას შეავსებს.'}</p>{actionError && <div className="admin-error" role="alert">{actionError}</div>}<footer className="admin-dialog-footer"><button type="button" className="admin-secondary" disabled={busy} onClick={() => setPending(null)}>გაუქმება</button><button className={pending.action === 'delete' ? 'admin-danger-button' : 'admin-primary'} disabled={busy}>{busy && <Loader2 size={16} className="admin-spin" />}{pending.action === 'delete' ? 'წაშლა' : 'აღდგენა'}</button></footer></form></section></div>}
  </section>;
}
