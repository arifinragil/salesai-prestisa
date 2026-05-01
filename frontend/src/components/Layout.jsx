import Link from 'next/link';
import { useRouter } from 'next/router';
import { useUser } from '@/lib/useUser';
import { api } from '@/lib/api';

const navItems = [
  { href: '/inbox',       label: 'Inbox' },
  { href: '/ai-monitor',  label: 'Monitor' },
  { href: '/ai-settings', label: 'Persona' },
];

export default function Layout({ children, title = 'Tiara CRM' }) {
  const router = useRouter();
  const { user, isLoading, unauthenticated } = useUser({ redirectTo: '/login' });

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace('/login');
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }
  if (unauthenticated || !user) {
    return null; // useUser will redirect
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-6">
          <Link href="/inbox" className="font-semibold text-slate-800">Tiara CRM</Link>
          <nav className="flex gap-1">
            {navItems.map((item) => {
              const active = router.pathname === item.href ||
                (item.href === '/inbox' && router.pathname.startsWith('/inbox'));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition ${
                    active
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-500">{user.username} ({user.role})</span>
          <a
            href="/admin/waha-sessions.html"
            className="text-slate-400 hover:text-slate-700"
            title="WAHA session admin"
          >
            ⚙
          </a>
          <button
            onClick={logout}
            className="text-slate-500 hover:text-rose-600"
          >
            Logout
          </button>
        </div>
      </header>
      <main className="flex-1">
        <title>{title}</title>
        {children}
      </main>
    </div>
  );
}
