import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarDays, Loader2, Printer, RefreshCw, X } from 'lucide-react';
import { directions, request, type Booking, type Direction, type Stop } from '../../api';
import BookingPrintReport from './BookingPrintReport';
import './booking-print.css';

type Options = { date: string; direction: Direction | 'both'; time: string | null };
type Report = Options & { key: string; bookings: Booking[]; stops: Stop[] };
type PrintFrame = { element: HTMLIFrameElement; root: Root; dispose: () => void };
type Props = { date: string; direction: Direction; time: string; onClose: () => void };
const optionKey = (options: Options) => `${options.date}:${options.direction}:${options.time || 'all'}`;
const failureMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'ბეჭდვის მონაცემები ვერ ჩაიტვირთა. სცადეთ ხელახლა.';

async function waitForPrintReady(ready: Promise<void>): Promise<void> {
  let timeout: number | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error('საბეჭდი ანგარიშის მომზადებას დიდი დრო დასჭირდა. სცადეთ ხელახლა.')), 20_000);
      }),
    ]);
  } finally { window.clearTimeout(timeout); }
}

async function loadReport(options: Options, signal?: AbortSignal): Promise<Report> {
  const params = new URLSearchParams({ scope: 'scheduled', date: options.date });
  if (options.direction !== 'both') params.set('direction', options.direction);
  if (options.time) params.set('time', options.time);
  const [orders, stops] = await Promise.all([
    request<{ bookings: Booking[] }>(`/admin/bookings?${params}`, { signal }),
    request<{ stops: Stop[] }>('/admin/stops', { signal }),
  ]);
  const bookings = orders.bookings.filter(booking => booking.status === 'confirmed' && !booking.deletedAt && booking.assignedDate === options.date && (options.direction === 'both' || booking.direction === options.direction) && (!options.time || booking.assignedTime === options.time));
  return { ...options, key: optionKey(options), bookings, stops: stops.stops };
}

function preparePrintFrame(report: Report): { frame: PrintFrame; ready: Promise<void> } {
  const element = document.createElement('iframe');
  element.id = 'greentaxi-print-frame'; element.name = 'greentaxi-print-frame';
  element.title = 'ჯავშნების საბეჭდი ანგარიში'; element.className = 'admin-booking-print-frame';
  element.setAttribute('aria-hidden', 'true');
  document.body.append(element);
  const target = element.contentDocument;
  const targetWindow = element.contentWindow;
  if (!target || !targetWindow) { element.remove(); throw new Error('საბეჭდი ფანჯარა ვერ მომზადდა. სცადეთ ხელახლა.'); }
  target.documentElement.lang = 'ka'; target.title = 'GreenTaxi — ჯავშნების ანგარიში';
  const base = target.createElement('base'); base.href = document.baseURI; target.head.append(base);
  const styles = Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]')).map(source => {
    const copy = source.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
    if (copy instanceof HTMLLinkElement) {
      const loaded = new Promise<void>((resolve, reject) => { copy.onload = () => resolve(); copy.onerror = () => reject(new Error('საბეჭდი სტილების ჩატვირთვა ვერ მოხერხდა. სცადეთ ხელახლა.')); });
      target.head.append(copy); return loaded;
    }
    target.head.append(copy); return Promise.resolve();
  });
  const reset = target.createElement('style'); reset.textContent = 'html,body{margin:0!important;padding:0!important;background:#fff!important;color:#111;}'; target.head.append(reset);
  const mount = target.createElement('div'); target.body.append(mount);
  const root = createRoot(mount);
  flushSync(() => root.render(<BookingPrintReport bookings={report.bookings} stops={report.stops} date={report.date} direction={report.direction} time={report.time} />));
  let disposed = false;
  const frame: PrintFrame = { element, root, dispose: () => { if (disposed) return; disposed = true; root.unmount(); element.remove(); } };
  const ready = Promise.all(styles).then(async () => {
    if (disposed) return;
    target.documentElement.getBoundingClientRect();
    if (target.fonts) {
      await Promise.all([
        target.fonts.load('400 12px "Dachi The Lynx"', 'ჯავშნების სია'),
        ...[400, 600, 700, 800].map(weight => target.fonts.load(`${weight} 12px "FiraGO"`, 'მგზავრი 568 69 48 79')),
      ]);
      await target.fonts.ready;
    }
    await Promise.all(Array.from(target.images).map(img => img.complete ? Promise.resolve() : new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('საბეჭდი სურათის ჩატვირთვა ვერ მოხერხდა.')); })));
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  return { frame, ready };
}

export default function BookingPrint({ date: initialDate, direction: initialDirection, time: initialTime, onClose }: Props) {
  const [date, setDate] = useState(initialDate);
  const [direction, setDirection] = useState<Direction | 'both'>(initialDirection);
  const [mode, setMode] = useState<'all' | 'selected'>(initialTime ? 'selected' : 'all');
  const [time, setTime] = useState(initialTime || '06:00');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const frame = useRef<PrintFrame | null>(null);
  const printController = useRef<AbortController | null>(null);
  const active = useRef(true);
  const options: Options = { date, direction, time: mode === 'selected' ? time : null };
  const key = optionKey(options);
  const valid = !!date && (mode === 'all' || /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
  const currentReport = report?.key === key ? report : null;

  useEffect(() => {
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    active.current = true;
    return () => { active.current = false; document.body.style.overflow = previous; printController.current?.abort(); frame.current?.dispose(); };
  }, []);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !printing) onClose(); }; document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close); }, [onClose, printing]);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setLoading(valid);
    if (!valid) return () => controller.abort();
    loadReport(options, controller.signal).then(result => { if (!controller.signal.aborted) setReport(result); }).catch(cause => { if (!controller.signal.aborted) setError(failureMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [key, valid, revision]);

  async function print() {
    if (printing || loading || error || !currentReport?.bookings.length || !valid) return;
    setPrinting(true); setError('');
    printController.current = new AbortController();
    const signal = printController.current.signal;
    const previousFocus = document.activeElement;
    try {
      // Printing always takes a new complete snapshot, independent of the visible list.
      const fresh = await loadReport(options, signal);
      if (!active.current || signal.aborted) return;
      setReport(fresh);
      if (!fresh.bookings.length) return;
      frame.current?.dispose();
      const prepared = preparePrintFrame(fresh); frame.current = prepared.frame;
      await waitForPrintReady(prepared.ready);
      if (!active.current || signal.aborted || frame.current !== prepared.frame) return;
      const printWindow = prepared.frame.element.contentWindow;
      if (!printWindow) throw new Error('საბეჭდი ფანჯარა ვერ გაიხსნა. სცადეთ ხელახლა.');
      printWindow.addEventListener('afterprint', () => { prepared.frame.dispose(); if (frame.current === prepared.frame) frame.current = null; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); }, { once: true });
      printWindow.focus(); printWindow.print();
    } catch (cause) {
      if (active.current && !signal.aborted) { setError(failureMessage(cause)); setReport(null); frame.current?.dispose(); frame.current = null; }
    } finally { if (active.current) setPrinting(false); }
  }

  return <div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !printing) onClose(); }}>
    <section className="admin-dialog admin-print-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-print-title">
      <header><div><h2 id="admin-print-title">ჯავშნების ბეჭდვა</h2><p>შეარჩიეთ დღე და დრო. ანგარიში მოიცავს ყველა დადასტურებულ ჯავშანს.</p></div><button className="admin-icon-button" disabled={printing} onClick={onClose} aria-label="დახურვა"><X size={21} /></button></header>
      <div className="admin-print-body">
        <div className="admin-print-options"><label>თარიღი<input type="date" aria-label="საბეჭდი თარიღი" value={date} disabled={printing} onChange={event => setDate(event.target.value)} /></label><label>მიმართულება<select aria-label="საბეჭდი მიმართულება" value={direction} disabled={printing} onChange={event => setDirection(event.target.value as Direction | 'both')}>{Object.entries(directions).map(([value, label]) => <option value={value} key={value}>{label}</option>)}<option value="both">ორივე მიმართულება</option></select></label><label>დროის შერჩევა<select aria-label="ბეჭდვის რეჟიმი" value={mode} disabled={printing} onChange={event => setMode(event.target.value as 'all' | 'selected')}><option value="all">მთელი დღე</option><option value="selected">არჩეული დრო</option></select></label>{mode === 'selected' && <label>დრო<input type="time" aria-label="საბეჭდი დრო" value={time} disabled={printing} onChange={event => setTime(event.target.value)} /></label>}</div>
        {!valid && <div className="admin-notice">აირჩიეთ თარიღი და მოქმედი დრო.</div>}
        {error && <div className="admin-error" role="alert">{error}<button disabled={printing} onClick={() => setRevision(value => value + 1)} aria-label="საბეჭდი მონაცემების განახლება">ხელახლა ცდა</button></div>}
        {loading || printing ? <div className="admin-print-loading" role="status"><Loader2 className="admin-spin" size={25} />{printing ? 'საბეჭდი ანგარიშის მომზადება…' : 'ჯავშნები იტვირთება…'}</div> : currentReport && !currentReport.bookings.length ? <div className="admin-print-empty"><CalendarDays size={30} /><h3>არჩეული პირობებით ჯავშნები არ არის</h3><p>შეცვალეთ თარიღი, მიმართულება ან დრო.</p></div> : currentReport && <div className="admin-print-preview" aria-label="საბეჭდი ანგარიშის წინასწარი ნახვა"><BookingPrintReport bookings={currentReport.bookings} stops={currentReport.stops} date={date} direction={direction} time={options.time} /></div>}
      </div>
      <footer className="admin-print-footer"><span>A4 · ალბომური</span><div><button className="admin-secondary" disabled={printing || loading} onClick={() => setRevision(value => value + 1)} aria-label="საბეჭდი მონაცემების განახლება"><RefreshCw size={15} />განახლება</button><button className="admin-secondary" disabled={printing} onClick={onClose}>გაუქმება</button><button className="admin-primary" disabled={printing || loading || !!error || !valid || !currentReport?.bookings.length} onClick={() => { void print(); }}>{printing ? <Loader2 className="admin-spin" size={17} /> : <Printer size={17} />}ბეჭდვა / PDF</button></div></footer>
    </section>
  </div>;
}
