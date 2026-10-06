import { useEffect, useState } from 'react';
import AdminDashboard from './components/AdminDashboard';
import BookingPage from './components/BookingPage';
import { previewUser } from './htmlPreviewApi';

export default function HtmlPreview() {
  const readView = () => ['#public', '#booking'].includes(window.location.hash) ? 'public' : 'admin';
  const [view, setView] = useState(readView);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const changeView = () => {
      setView(readView());
      setNotice('');
    };
    const followLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      const href = anchor?.getAttribute('href');
      if (href === '/' || href === '/admin') {
        event.preventDefault();
        window.location.hash = href === '/admin' ? 'admin' : 'public';
        window.scrollTo({ top: 0 });
      } else if (href?.startsWith('tel:')) {
        event.preventDefault();
        setNotice('სატესტო ნომერია — დიზაინის ნახვისას ზარი არ ხორციელდება.');
        setExpanded(true);
      }
    };
    window.addEventListener('hashchange', changeView);
    document.addEventListener('click', followLink, true);
    return () => {
      window.removeEventListener('hashchange', changeView);
      document.removeEventListener('click', followLink, true);
    };
  }, []);

  return <>
    <aside className="html-preview-control" aria-label="დიზაინის წინასწარი ნახვა" data-preview-view={view}>
      <button type="button" className="html-preview-toggle" aria-expanded={expanded} aria-controls="html-preview-options" onClick={() => setExpanded(value => !value)}>სატესტო მონაცემები<span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
      {expanded && <div id="html-preview-options" className="html-preview-options">
        <p>მხოლოდ დიზაინის ნახვა. რეალური ჯავშნები არ იგზავნება.</p>
        <nav aria-label="წინასწარი ნახვის გვერდები">
          <a href="#public" aria-current={view === 'public' ? 'page' : undefined}>მგზავრის გვერდი</a>
          <a href="#admin" aria-current={view === 'admin' ? 'page' : undefined}>ადმინისტრაცია</a>
        </nav>
        {notice && <span className="html-preview-notice" role="status">{notice}</span>}
      </div>}
    </aside>
    {view === 'admin' ? <AdminDashboard user={previewUser} onLogout={() => { window.location.hash = 'public'; }} /> : <BookingPage />}
  </>;
}
