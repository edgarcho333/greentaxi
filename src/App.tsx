import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Leaf, LockKeyhole, UserRound } from 'lucide-react';
import { request, type User } from './api';
import BookingPage from './components/BookingPage';
import AdminDashboard from './components/AdminDashboard';

type Session = { user: User | null; needsSetup: boolean; requiresSetupToken?: boolean };

export default function App() {
  const isAdmin = window.location.pathname.startsWith('/admin');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(isAdmin);
  const loadSession = async () => {
    setLoading(true);
    setError('');
    try { setSession(await request<Session>('/auth/session')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'დაკავშირება ვერ მოხერხდა.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (isAdmin) void loadSession(); }, [isAdmin]);

  if (!isAdmin) return <BookingPage />;
  if (loading) return <div className="app-loading" role="status"><Leaf size={36} /><span>იტვირთება…</span></div>;
  if (!session) return <div className="app-loading"><p role="alert">{error}</p><button onClick={loadSession}>ხელახლა ცდა</button></div>;
  if (session.user) return <AdminDashboard user={session.user} onLogout={async () => {
    try {
      await request('/auth/logout', { method: 'POST', body: '{}' });
      setSession({ user: null, needsSetup: false });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'გამოსვლა ვერ მოხერხდა.'); }
  }} />;
  return <Login session={session} error={error} onLogin={user => setSession({ user, needsSetup: false })} />;
}

function Login({ session, error: outerError, onLogin }: { session: Session; error: string; onLogin: (user: User) => void }) {
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(outerError);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await request<{ user: User }>(session.needsSetup ? '/auth/setup' : '/auth/login', {
        method: 'POST', body: JSON.stringify({ login, name, password, ...(setupToken ? { setupToken } : {}) }),
      });
      onLogin(result.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'შესვლა ვერ მოხერხდა.'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <div className="auth-brand-panel">
      <a className="auth-logo" href="/" aria-label="GreenTaxi"><Leaf /><span><b>Green</b>Taxi</span></a>
      <div className="auth-brand-copy"><span className="auth-eyebrow">გორი ↔ თბილისი</span><h1>ყველა ჯავშანი.<br />ერთ სივრცეში.</h1><p>მართეთ მგზავრობა მარტივად — შემოსული განაცხადიდან დადასტურებულ ჯავშნამდე.</p></div>
      <div className="auth-brand-bottom"><span className="auth-dot" /> GREEN TAXI · ყოველდღე თქვენთან</div>
    </div>
    <div className="auth-form-panel">
      <a href="/" className="auth-back"><ArrowLeft size={17} /> საიტზე დაბრუნება</a>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-icon"><LockKeyhole size={25} /></div>
        <h2>{session.needsSetup ? 'პირველი თანამშრომელი' : 'მოგესალმებით'}</h2>
        <p>{session.needsSetup ? 'შექმენით ანგარიში ადმინისტრაციულ პანელში სამუშაოდ.' : 'შედით GreenTaxi-ის მართვის პანელში.'}</p>
        {session.needsSetup && <label>სახელი<input value={name} onChange={event => setName(event.target.value)} required maxLength={100} autoComplete="name" /></label>}
        <label>მომხმარებლის სახელი<div className="auth-input"><UserRound size={17} /><input value={login} onChange={event => setLogin(event.target.value)} required maxLength={80} autoComplete="username" autoCapitalize="none" /></div></label>
        <label>პაროლი<div className="auth-input"><LockKeyhole size={17} /><input type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={session.needsSetup ? 10 : 1} autoComplete={session.needsSetup ? 'new-password' : 'current-password'} /></div></label>
        {session.needsSetup && <small>გამოიყენეთ მინიმუმ 10 სიმბოლო.</small>}
        {session.needsSetup && session.requiresSetupToken && <label>აქტივაციის კოდი<input type="password" value={setupToken} onChange={event => setSetupToken(event.target.value)} required autoComplete="off" /></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="auth-submit" disabled={busy}>{busy ? 'იტვირთება…' : session.needsSetup ? 'ანგარიშის შექმნა' : 'შესვლა'}<ArrowRight size={18} /></button>
        <span className="auth-note"><LockKeyhole size={13} /> მხოლოდ თანამშრომლებისთვის</span>
      </form>
      <div className="auth-footer">GreenTaxi · გორი — თბილისი</div>
    </div>
  </main>;
}
