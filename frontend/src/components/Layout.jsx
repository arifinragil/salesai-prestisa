import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { useUser } from '@/lib/useUser';
import { api } from '@/lib/api';
import MessageSearch from './MessageSearch';
import NotificationsBell from './NotificationsBell';

const navItems = [
  { href: '/inbox',           label: 'Inbox',     short: 'Inbox' },
  { href: '/pipeline',        label: 'Pipeline',  short: 'Pipe' },
  { href: '/tasks',           label: 'Tasks',     short: 'Tasks' },
  { href: '/supervisor',      label: 'Supervisor', short: 'Sup', adminOnly: true },
  { href: '/lead-distribution', label: 'Leads',   short: 'Leads', adminOnly: true },
  { href: '/ai-monitor',      label: 'Monitor',   short: 'Monitor' },
  { href: '/ai-settings',     label: 'Persona',   short: 'Persona' },
  { href: '/knowledge',       label: 'Knowledge', short: 'KB' },
  { href: '/reply-templates', label: 'Templates', short: 'Tmpl' },
  { href: '/tags',            label: 'Tags',      short: 'Tags' },
  { href: '/promos',          label: 'Promo',     short: 'Promo' },
  { href: '/sql-queries',     label: 'SQL',       short: 'SQL' },
  { href: '/users',           label: 'Users',     short: 'Users' },
  { href: '/snippets',        label: 'Snippets',  short: 'Snip' },
];

function isActive(pathname, href) {
  if (pathname === href) return true;
  if (href === '/inbox' && pathname.startsWith('/inbox')) return true;
  return false;
}

export default function Layout({ children, title = 'Tiara CRM' }) {
  const router = useRouter();
  const { user, isLoading, unauthenticated } = useUser({ redirectTo: '/login' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Cmd/Ctrl+K opens search globally
  useEffect(() => {
    function handler(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close drawer on route change
  useEffect(() => {
    function close() { setDrawerOpen(false); }
    router.events.on('routeChangeStart', close);
    return () => router.events.off('routeChangeStart', close);
  }, [router.events]);

  // Presence heartbeat — ping every 45s when logged in
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const beat = () => { if (!cancelled) api('/api/users/me/heartbeat', { method: 'POST' }).catch(() => {}); };
    beat();
    const t = setInterval(beat, 45_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [user?.id || user?.username]);

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
  if (unauthenticated || !user) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="px-3 sm:px-6 py-3 flex items-center justify-between gap-2">
          {/* Mobile burger + brand */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Buka menu navigasi"
              className="md:hidden w-10 h-10 inline-flex items-center justify-center rounded-md text-slate-700 hover:bg-slate-100"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            <Link href="/inbox" className="font-semibold text-slate-800 truncate">
              Tiara CRM
            </Link>
            {/* Desktop nav */}
            <nav className="hidden md:flex gap-1 ml-4">
              {navItems.filter((it) => !it.adminOnly || user?.role === 'admin').map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md text-sm transition ${
                    isActive(router.pathname, item.href)
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setSearchOpen(true)}
              aria-label="Cari pesan (Cmd/Ctrl+K)"
              className="md:hidden w-10 h-10 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              onClick={() => setSearchOpen(true)}
              className="hidden md:flex items-center gap-2 px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-md hover:bg-slate-50"
              title="Cari pesan (Cmd/Ctrl+K)"
            >
              <span>🔍 Cari</span>
              <kbd className="text-[10px] px-1 py-0.5 bg-slate-100 rounded border border-slate-200 text-slate-500">⌘K</kbd>
            </button>
            <NotificationsBell />
            <span className="hidden lg:inline text-sm text-slate-500 truncate max-w-[160px]" title={`${user.username} (${user.role})`}>
              {user.username} ({user.role})
            </span>
            <a
              href="/admin/waha-sessions.html"
              className="hidden md:inline w-9 h-9 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 inline-flex"
              title="WAHA session admin"
              aria-label="WAHA session admin"
            >
              ⚙
            </a>
            <button
              onClick={logout}
              className="hidden md:inline text-sm text-slate-500 hover:text-rose-600 px-2 py-1.5"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-30" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Tutup menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white shadow-xl flex flex-col">
            <div className="px-4 py-4 border-b border-slate-200 flex items-center justify-between">
              <span className="font-semibold text-slate-800">Tiara CRM</span>
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Tutup menu"
                className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
              >
                ✕
              </button>
            </div>
            <nav className="flex-1 px-2 py-3 overflow-y-auto">
              {navItems.filter((it) => !it.adminOnly || user?.role === 'admin').map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block px-4 py-3 rounded-md text-sm mb-1 ${
                    isActive(router.pathname, item.href)
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
              <div className="border-t border-slate-100 mt-2 pt-2">
                <a
                  href="/admin/waha-sessions.html"
                  className="block px-4 py-3 rounded-md text-sm text-slate-700 hover:bg-slate-100"
                >
                  ⚙ WAHA Sessions
                </a>
                <a
                  href="/admin/settings.html"
                  className="block px-4 py-3 rounded-md text-sm text-slate-700 hover:bg-slate-100"
                >
                  ⚙ Admin Settings (legacy)
                </a>
              </div>
            </nav>
            <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between">
              <span className="text-sm text-slate-500 truncate" title={`${user.username} (${user.role})`}>
                {user.username} <span className="text-slate-400">({user.role})</span>
              </span>
              <button
                onClick={() => { setDrawerOpen(false); logout(); }}
                className="text-sm text-rose-600 px-3 py-1.5 rounded-md hover:bg-rose-50"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1">
        <title>{title}</title>
        {children}
      </main>
      <MessageSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
