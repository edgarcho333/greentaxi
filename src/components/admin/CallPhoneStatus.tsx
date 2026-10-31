import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Download, RefreshCw, Smartphone } from 'lucide-react';
import { request, type CallDevice } from '../../api';
import './call-phone-status.css';

const POLL_MS = 15_000;
const TIMEOUT_MS = 8_000;
const CALL_RECEIVER_VERSION = '0.2.3';
type ConnectionState = 'online' | 'stale' | 'unknown' | 'disabled';

export function callDeviceTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'ჯერ არ მიღებულა';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function callDeviceError(code: string | null | undefined) {
  if (!code) return null;
  if (code === 'network') return 'ინტერნეტთან კავშირი ვერ დამყარდა';
  if (code === 'permission') return 'აპს ზარების წვდომა აკლია';
  if (code === 'storage') return 'ტელეფონში შენახვის შეცდომაა';
  if (code === 'http_401' || code === 'http_403') return 'შეამოწმეთ ტელეფონის დაკავშირების კოდი';
  if (code === 'http_429') return 'გაგზავნა დროებით შეჩერებულია — აპი ხელახლა სცდის';
  if (code === 'http_408' || code === 'http_504') return 'სერვერის პასუხს ვერ მივიღეთ — აპი ხელახლა სცდის';
  if (/^http_5\d{2}$/.test(code)) return 'სერვერი დროებით მიუწვდომელია — აპი ხელახლა სცდის';
  return 'ბოლო გაგზავნისას შეცდომა მოხდა';
}

export function useCallDevices() {
  const [devices, setDevices] = useState<CallDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  // A local create/revoke response takes precedence over an older poll.
  const updateDevices = useCallback((update: (current: CallDevice[]) => CallDevice[]) => {
    sequence.current++;
    setDevices(update);
    setRevision(value => value + 1);
  }, []);

  useEffect(() => {
    let active = true, inFlight = false;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    const load = async () => {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      const selectedSequence = ++sequence.current;
      controller = new AbortController();
      const selectedController = controller;
      timeout = window.setTimeout(() => selectedController.abort(), TIMEOUT_MS);
      try {
        const result = await request<{ devices: CallDevice[] }>('/admin/devices/status', { signal: selectedController.signal });
        if (active && !selectedController.signal.aborted && selectedSequence === sequence.current) {
          setDevices(result.devices); setError('');
        }
      } catch {
        if (active && selectedSequence === sequence.current) setError('ტელეფონების სტატუსი ვერ განახლდა. კავშირი შეამოწმეთ ან სცადეთ ხელახლა.');
      } finally {
        window.clearTimeout(timeout); inFlight = false;
        if (active && selectedSequence === sequence.current) setLoading(false);
      }
    };
    void load();
    const visible = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(visible, POLL_MS);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => {
      active = false; controller?.abort(); window.clearTimeout(timeout); window.clearInterval(timer);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, [revision]);

  return { devices, updateDevices, loading, error, refresh };
}

function stateFor(device: CallDevice, available = true): ConnectionState {
  if (!device.active || device.connectionState === 'disabled') return 'disabled';
  if (!available) return 'unknown';
  return device.connectionState ?? 'unknown';
}

export function CallDeviceConnectionBadge({ device, available = true }: { device: CallDevice; available?: boolean }) {
  const state = stateFor(device, available);
  const label = state === 'online' ? 'ტელეფონი კავშირზეა' : state === 'stale' ? device.heartbeat?.monitoring === false ? 'ბოლო ანგარიშში გამორთულია' : 'სტატუსი არ განახლებულა' : state === 'disabled' ? 'წვდომა გაუქმებულია' : available ? 'სტატუსი უცნობია' : 'სტატუსი ვერ განახლდა';
  const Icon = state === 'online' ? CheckCircle2 : state === 'disabled' ? Smartphone : Clock3;
  return <span className={`call-phone-connection ${state}`} data-call-phone-connection data-connection-state={state}><Icon size={18} />{label}</span>;
}

function CallReceiverDownload() {
  return <span className="call-phone-summary-help call-phone-download-help"><span>დააყენეთ Green Taxi Samsung 2 და ხელახლა დააკავშირეთ ტელეფონი. ახალი მონიტორინგი ჯერ გამორთული დატოვეთ. ზარებს შორის დაელოდეთ ძველში „გასაგზავნი ზარები: 0“-ს, გამორთეთ ძველი და მაშინვე ჩართეთ ახალი მონიტორინგი.</span><a className="call-phone-download-link" href="/downloads/GreenTaxi-Samsung-2.apk" download="GreenTaxi-Samsung-2.apk" aria-label="ახალი აპის ჩამოტვირთვა: Green Taxi Samsung 2" data-call-phone-apk><Download size={18} />ახალი აპის ჩამოტვირთვა</a></span>;
}

function needsCallReceiverUpdate(version: string) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!parts) return false;
  const current = CALL_RECEIVER_VERSION.split('.').map(Number);
  for (let index = 0; index < current.length; index++) {
    const supplied = Number(parts[index + 1]);
    if (supplied !== current[index]) return supplied < current[index];
  }
  return false;
}

function CallReceiverUpdate({ device }: { device: CallDevice }) {
  if (!device.active || !device.heartbeat || !needsCallReceiverUpdate(device.heartbeat.appVersion)) return null;
  return <div className="call-phone-update" data-call-phone-update>
    <span>ხელმისაწვდომია ვერსია {CALL_RECEIVER_VERSION}. აპის განახლებისას დაკავშირება შენარჩუნდება.</span>
    <a className="call-phone-download-link" href="/downloads/GreenTaxi-Samsung-2.apk" download="GreenTaxi-Samsung-2.apk" aria-label={`აპის განახლება ${CALL_RECEIVER_VERSION}: Green Taxi Samsung 2`} data-call-phone-apk><Download size={18} />განახლება {CALL_RECEIVER_VERSION}</a>
  </div>;
}

function StaleReportHelp({ device, available, showLastCall = false }: { device: CallDevice; available: boolean; showLastCall?: boolean }) {
  if (stateFor(device, available) !== 'stale') return null;
  const receivedAt = new Date(device.heartbeat?.receivedAt ?? '').getTime();
  const lastCallAt = new Date(device.lastSeenAt ?? '').getTime();
  return <div className="call-phone-report-help" data-call-phone-stale-help>
    <span>გახსენით აპი და შეამოწმეთ მონიტორინგი.</span>
    {showLastCall && Number.isFinite(lastCallAt) && lastCallAt > receivedAt && <span data-call-phone-last-call>ბოლო მიღებული ზარი: {callDeviceTime(device.lastSeenAt)}</span>}
  </div>;
}

export function CallDeviceTelemetry({ device, available = true }: { device: CallDevice; available?: boolean }) {
  const heartbeat = device.heartbeat;
  if (!heartbeat) return <div className="call-phone-unknown-help">{device.active && device.connectionState !== 'disabled' ? <CallReceiverDownload /> : 'მოწყობილობის წვდომა გაუქმებულია.'}</div>;
  const current = available && device.active && device.connectionState === 'online';
  return <div className="call-phone-diagnostics" data-call-phone-diagnostics>
    <p className={heartbeat.pendingCount > 0 ? 'call-phone-pending waiting' : 'call-phone-pending'} data-call-phone-pending>{current ? 'გასაგზავნია' : 'ბოლო ანგარიშში გასაგზავნი'}: <strong>{heartbeat.pendingCount}</strong></p>
    <dl>
      <div><dt>ბოლო სტატუსი</dt><dd>{callDeviceTime(heartbeat.receivedAt)}</dd></div>
      <div><dt>აპის ვერსია</dt><dd>{heartbeat.appVersion}</dd></div>
      <div><dt>Android</dt><dd>{heartbeat.androidVersion}</dd></div>
      <div><dt>მონიტორინგი ბოლო ანგარიშში</dt><dd>{heartbeat.monitoring ? 'ჩართულია' : 'გამორთულია'}</dd></div>
      {heartbeat.pendingCount > 0 && heartbeat.oldestPendingAt && <div><dt>უძველესი გასაგზავნი ზარი</dt><dd>{callDeviceTime(heartbeat.oldestPendingAt)}</dd></div>}
    </dl>
    {heartbeat.lastError && <p className="call-phone-delivery-error"><AlertCircle size={17} />{callDeviceError(heartbeat.lastError)}</p>}
    <StaleReportHelp device={device} available={available} />
    <CallReceiverUpdate device={device} />
  </div>;
}

export default function CallPhoneStatus() {
  const { devices, loading, error, refresh } = useCallDevices();
  const activeDevices = devices.filter(device => device.active);
  if (!loading && !error && activeDevices.length === 0) return null;
  return <section className="call-phone-status" aria-label="ზარების მიმღები ტელეფონების კავშირი" data-call-phone-status>
    <div className="call-phone-status-heading"><span><Smartphone size={21} />ზარების ტელეფონები</span><button type="button" onClick={refresh} disabled={loading} aria-label="ზარების ტელეფონების სტატუსის განახლება"><RefreshCw size={19} />განახლება</button></div>
    {loading && devices.length === 0 && <p className="call-phone-status-note" role="status">ტელეფონების სტატუსი იტვირთება…</p>}
    {error && <p className="call-phone-status-error" role="status"><AlertCircle size={18} />{error}</p>}
    {activeDevices.length > 0 && <div className="call-phone-status-devices">{activeDevices.map(device => <article className="call-phone-status-device" key={device.id} data-call-phone-device={device.id}>
      <strong>{device.name}</strong><CallDeviceConnectionBadge device={device} available={!error} />
      {device.heartbeat ? <span className={device.heartbeat.pendingCount > 0 ? 'call-phone-pending waiting' : 'call-phone-pending'} data-call-phone-pending>{!error && device.connectionState === 'online' ? 'გასაგზავნია' : 'ბოლო ანგარიშში გასაგზავნი'}: <b>{device.heartbeat.pendingCount}</b></span> : <CallReceiverDownload />}
      {device.heartbeat && !device.heartbeat.monitoring && <small>ბოლო ანგარიშში მონიტორინგი გამორთულია</small>}
      {device.heartbeat && (error || device.connectionState !== 'online' || device.heartbeat.pendingCount > 0) && <small>ბოლო სტატუსი: {callDeviceTime(device.heartbeat.receivedAt)}</small>}
      <StaleReportHelp device={device} available={!error} showLastCall />
      <CallReceiverUpdate device={device} />
    </article>)}</div>}
  </section>;
}
