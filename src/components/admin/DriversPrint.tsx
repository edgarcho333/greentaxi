import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { LoaderCircle, Printer, RefreshCw, UsersRound, X } from 'lucide-react';
import { request, today, type DriverSchedule } from '../../api';
import DriversPrintReport, { type PrintableDriver } from './DriversPrintReport';
import './drivers-print.css';

type Report = { drivers: PrintableDriver[]; preparedDate: string };
type PrintFrame = { element: HTMLIFrameElement; root: Root; dispose: () => void };
const failureMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'მძღოლების სია ვერ ჩაიტვირთა. სცადეთ ხელახლა.';

async function loadReport(signal?: AbortSignal): Promise<Report> {
  const preparedDate = today();
  // This endpoint contains the whole non-deleted roster, including drivers who
  // declined today. Restore the permanent bottom-to-top queue, not the daily rotation.
  const schedule = await request<DriverSchedule>(`/admin/drivers/schedule?direction=gori-tbilisi&date=${preparedDate}`, { signal });
  return { drivers: [...schedule.drivers].sort((first, second) => second.order - first.order || second.id - first.id), preparedDate };
}

function preparePrintFrame(report: Report): { frame: PrintFrame; ready: Promise<void> } {
  const element = document.createElement('iframe');
  element.id = 'greentaxi-drivers-print-frame'; element.title = 'მძღოლების საბეჭდი სია'; element.className = 'admin-drivers-print-frame';
  element.setAttribute('aria-hidden', 'true'); document.body.append(element);
  const target = element.contentDocument;
  if (!target || !element.contentWindow) { element.remove(); throw new Error('საბეჭდი ფანჯარა ვერ მომზადდა. სცადეთ ხელახლა.'); }
  target.documentElement.lang = 'ka'; target.title = 'GreenTaxi — მძღოლების სია';
  const base = target.createElement('base'); base.href = document.baseURI; target.head.append(base);
  const styles = Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]')).map(source => {
    const copy = source.cloneNode(true) as HTMLStyleElement | HTMLLinkElement;
    if (copy instanceof HTMLLinkElement) {
      const loaded = new Promise<void>((resolve, reject) => { copy.onload = () => resolve(); copy.onerror = () => reject(new Error('საბეჭდი სტილების ჩატვირთვა ვერ მოხერხდა. სცადეთ ხელახლა.')); });
      target.head.append(copy); return loaded;
    }
    target.head.append(copy); return Promise.resolve();
  });
  const reset = target.createElement('style');
  reset.textContent = '@page{size:A4 portrait;margin:10mm}html,body{margin:0!important;padding:0!important;background:#fff!important;color:#000;}';
  target.head.append(reset);
  const mount = target.createElement('div'); target.body.append(mount);
  const root = createRoot(mount);
  flushSync(() => root.render(<DriversPrintReport {...report} />));
  let disposed = false;
  const frame: PrintFrame = { element, root, dispose: () => { if (disposed) return; disposed = true; root.unmount(); element.remove(); } };
  const ready = Promise.all(styles).then(async () => {
    if (disposed) return;
    target.documentElement.getBoundingClientRect();
    if (target.fonts) {
      await Promise.all([400, 500, 600, 700, 800].map(weight => target.fonts.load(`${weight} 12px "FiraGO"`, 'მძღოლები 599 12 34 56')));
      await target.fonts.ready;
    }
    await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
  });
  return { frame, ready };
}

async function waitForPrintReady(ready: Promise<void>): Promise<void> {
  let timeout: number | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error('საბეჭდი სიის მომზადებას დიდი დრო დასჭირდა. სცადეთ ხელახლა.')), 20_000);
    })]);
  } finally { window.clearTimeout(timeout); }
}

export default function DriversPrint({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const frame = useRef<PrintFrame | null>(null);
  const printController = useRef<AbortController | null>(null);
  const active = useRef(true);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden'; active.current = true; closeButton.current?.focus();
    return () => {
      active.current = false; document.body.style.overflow = previousOverflow; printController.current?.abort(); frame.current?.dispose();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !printing) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !dialog.current) return;
      const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [onClose, printing]);
  useEffect(() => {
    const controller = new AbortController(); setReport(null); setError(''); setLoading(true);
    loadReport(controller.signal).then(result => { if (!controller.signal.aborted) setReport(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(failureMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function print() {
    if (printing || loading || error || !report?.drivers.length) return;
    setPrinting(true); setError('');
    printController.current = new AbortController(); const signal = printController.current.signal;
    const previousFocus = document.activeElement;
    try {
      const fresh = await loadReport(signal);
      if (!active.current || signal.aborted) return;
      setReport(fresh); if (!fresh.drivers.length) return;
      frame.current?.dispose(); const prepared = preparePrintFrame(fresh); frame.current = prepared.frame;
      await waitForPrintReady(prepared.ready);
      if (!active.current || signal.aborted || frame.current !== prepared.frame) return;
      const printWindow = prepared.frame.element.contentWindow;
      if (!printWindow) throw new Error('საბეჭდი ფანჯარა ვერ გაიხსნა. სცადეთ ხელახლა.');
      printWindow.addEventListener('afterprint', () => {
        prepared.frame.dispose(); if (frame.current === prepared.frame) frame.current = null;
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      }, { once: true });
      printWindow.focus(); printWindow.print();
    } catch (cause) {
      if (active.current && !signal.aborted) { setError(failureMessage(cause)); setReport(null); frame.current?.dispose(); frame.current = null; }
    } finally { if (active.current) setPrinting(false); }
  }

  return createPortal(<div className="admin-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !printing) onClose(); }}>
    <section ref={dialog} tabIndex={-1} className="admin-dialog admin-drivers-print-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-drivers-print-title">
      <header><div><h2 id="admin-drivers-print-title">ყველა მძღოლის ბეჭდვა</h2><p>მუდმივი რიგი, ტელეფონის ნომრები და ადგილები. სიაშია ისინიც, ვინც დღეს არ მუშაობს.</p></div><button ref={closeButton} type="button" className="admin-icon-button" disabled={printing} onClick={onClose} aria-label="დახურვა"><X size={23} /></button></header>
      <div className="admin-drivers-print-body">
        {error && <div className="admin-error" role="alert">{error}<button type="button" disabled={printing} onClick={() => setRevision(value => value + 1)}>ხელახლა ცდა</button></div>}
        {loading || printing ? <div className="admin-drivers-print-state" role="status"><LoaderCircle className="admin-spin" size={27} />{printing ? 'საბეჭდი სიის მომზადება…' : 'მძღოლების სია იტვირთება…'}</div>
          : report && !report.drivers.length ? <div className="admin-drivers-print-state"><UsersRound size={30} /><p>მძღოლების სია ცარიელია.</p></div>
          : report && <div className="admin-drivers-print-preview" aria-label="მძღოლების სიის წინასწარი ნახვა"><DriversPrintReport {...report} /></div>}
      </div>
      <footer className="admin-drivers-print-footer"><span>A4 · ვერტიკალური</span><div><button type="button" className="admin-secondary" disabled={printing || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={19} />განახლება</button><button type="button" className="admin-secondary" disabled={printing} onClick={onClose}>გაუქმება</button><button type="button" className="admin-primary" disabled={printing || loading || !!error || !report?.drivers.length} onClick={() => { void print(); }}>{printing ? <LoaderCircle className="admin-spin" size={21} /> : <Printer size={21} />}ბეჭდვა / PDF</button></div></footer>
    </section>
  </div>, document.body);
}
