import { useEffect, useRef, useState } from 'react';
import { Download, HousePlus, MoreVertical, Share, Smartphone, X } from 'lucide-react';
import './driver-install.css';

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type Platform = 'ios' | 'android' | null;
const dismissalKey = 'greentaxi_driver_install_dismissed_at';
const dismissalDuration = 7 * 24 * 60 * 60 * 1_000;

function platform(): Platform {
  if (/GreenTaxiDriver\//i.test(navigator.userAgent)) return null;
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return /Android/i.test(navigator.userAgent) ? 'android' : null;
}

function standalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function wasDismissed() {
  try {
    const timestamp = Number(localStorage.getItem(dismissalKey));
    return timestamp > 0 && timestamp <= Date.now() && Date.now() - timestamp < dismissalDuration;
  } catch { return false; }
}

/** Lives above the login/home switch so a pending browser prompt survives login. */
export function useDriverInstall() {
  const [device] = useState(platform);
  const [installed, setInstalled] = useState(standalone);
  const [dismissed, setDismissed] = useState(wasDismissed);
  const [instructions, setInstructions] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (/GreenTaxiDriver\//i.test(navigator.userAgent)) return () => { mounted.current = false; };
    const originalTitle = document.title;
    document.title = 'GreenTaxi — მძღოლი';
    const elements: HTMLElement[] = [];
    const append = (tag: 'link' | 'meta', attributes: Record<string, string>) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      element.setAttribute('data-driver-install-meta', '');
      document.head.append(element); elements.push(element);
    };
    append('link', { rel: 'manifest', href: '/driver.webmanifest' });
    append('link', { rel: 'apple-touch-icon', href: '/driver-icons/apple-touch-icon.png', sizes: '180x180' });
    append('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    append('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    append('meta', { name: 'apple-mobile-web-app-title', content: 'GreenTaxi' });
    append('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'default' });

    const displayMode = window.matchMedia('(display-mode: standalone)');
    const displayChanged = () => setInstalled(standalone());
    const offered = (event: Event) => {
      if (!device || standalone()) return;
      event.preventDefault(); setPrompt(event as InstallPrompt);
    };
    const accepted = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', offered);
    window.addEventListener('appinstalled', accepted);
    displayMode.addEventListener?.('change', displayChanged);
    // Navigation stays online; this worker never stores orders, sessions, or API responses.
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/driver-sw.js', { scope: '/driver', updateViaCache: 'none' }).catch(() => {});
    }
    return () => {
      mounted.current = false;
      elements.forEach(element => element.remove()); document.title = originalTitle;
      window.removeEventListener('beforeinstallprompt', offered);
      window.removeEventListener('appinstalled', accepted);
      displayMode.removeEventListener?.('change', displayChanged);
    };
  }, [device]);

  function dismiss() {
    try { localStorage.setItem(dismissalKey, String(Date.now())); } catch { /* Private browsing can deny storage. */ }
    setDismissed(true); setInstructions(false);
  }
  function reopen() { setDismissed(false); setInstructions(true); }
  async function install() {
    if (busy) return;
    if (!prompt) { setInstructions(true); return; }
    const current = prompt; setPrompt(null); setBusy(true);
    try {
      await current.prompt();
      const choice = await current.userChoice;
      if (!mounted.current) return;
      if (choice.outcome === 'accepted') setInstalled(true);
      else setInstructions(true);
    } catch { if (mounted.current) setInstructions(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  return { device, installed, dismissed, instructions, busy, canPrompt: !!prompt, dismiss, reopen, install, closeInstructions: () => setInstructions(false) };
}

export type DriverInstallState = ReturnType<typeof useDriverInstall>;

export default function DriverInstallOffer({ install }: { install: DriverInstallState }) {
  if (!install.device || install.installed) return null;
  if (install.dismissed) return <div className="driver-install-reopen"><button type="button" onClick={install.reopen}><HousePlus size={19} />მთავარ ეკრანზე დამატება</button></div>;
  const ios = install.device === 'ios';
  return <section className="driver-install-offer" aria-label="მთავარ ეკრანზე დამატება" data-driver-install-offer>
    <div className="driver-install-heading"><Smartphone size={24} /><h2>GreenTaxi მთავარ ეკრანზე</h2><button type="button" className="driver-install-dismiss" aria-label="დამატების შეთავაზების დახურვა" onClick={install.dismiss}><X size={23} /></button></div>
    <p>მძღოლის გვერდი ერთი შეხებით გახსენით — როგორც აპი.</p>
    <button type="button" className="driver-install-action" aria-expanded={install.instructions} aria-controls="driver-install-instructions" disabled={install.busy} onClick={() => void install.install()}><HousePlus size={22} />{install.busy ? 'იხსნება…' : ios || !install.canPrompt ? 'როგორ დავამატო?' : 'დამატება'}</button>
    {install.instructions && <div id="driver-install-instructions" className="driver-install-instructions">
      <ol>{ios ? <><li>გახსენით ეს გვერდი <strong>Safari</strong>-ში.</li><li>დააჭირეთ <Share size={20} aria-hidden="true" /> <strong>გაზიარებას</strong> (Share).</li><li>აირჩიეთ <strong>მთავარ ეკრანზე დამატება</strong> (Add to Home Screen), შემდეგ — <strong>დამატება</strong> (Add).</li></> : <><li>გახსენით ეს გვერდი <strong>Chrome</strong>-ში ან <strong>Samsung Internet</strong>-ში.</li><li>გახსენით ბრაუზერის <MoreVertical size={20} aria-hidden="true" /> <strong>მენიუ</strong>.</li><li>აირჩიეთ <strong>მთავარ ეკრანზე დამატება</strong> ან <strong>აპის დაყენება</strong> და დაადასტურეთ.</li></>}</ol>
      <p className="driver-install-note">შესასვლელად ისევ თქვენი ტელეფონის ნომერი გამოიყენეთ. ჯავშნების სანახავად ინტერნეტია საჭირო.</p>
      <button type="button" className="driver-install-understood" onClick={install.closeInstructions}>გასაგებია</button>
    </div>}
  </section>;
}

export function DriverAndroidDownload({ device }: { device: Platform }) {
  if (device === 'ios' || /GreenTaxiDriver\//i.test(navigator.userAgent)) return null;
  return <a className="driver-download-link" href="/downloads/GreenTaxi-Driver-Android.apk" download><Download size={24} />Android აპის ჩამოტვირთვა</a>;
}
