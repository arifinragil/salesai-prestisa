import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState, useEffect } from 'react';
import { useUser } from '@/lib/useUser';
import { api } from '@/lib/api';
import MessageSearch from './MessageSearch';
import NotificationsBell from './NotificationsBell';

const navItems = [
  { href: '/inbox',             label: 'Inbox',      icon: '💬' },
  { href: '/lotus-inbox',       label: 'Lotus Inbox',icon: '🪷' },
  { href: '/customer',          label: 'Customer',   icon: '🎫' },
  { href: '/tax-requests',      label: 'Faktur Pajak', icon: '🧾' },
  { href: '/pipeline',          label: 'Pipeline',   icon: '📊' },
  { href: '/tasks',             label: 'Tasks',      icon: '✅' },
  { href: '/supervisor',        label: 'Supervisor', icon: '👁',  adminOnly: true },
  { href: '/supervisor-control', label: 'Supervisor Control', icon: '👁‍🗨', adminOnly: true },
  { href: '/lead-distribution', label: 'Leads',      icon: '🎯', adminOnly: true },
  { href: '/retention',         label: 'Retention',  icon: '🔁', adminOnly: true },
  { href: '/b2b-outreach',      label: 'B2B Outreach', icon: '🏢', adminOnly: true },
  { href: '/ai-monitor',        label: 'Monitor',    icon: '📡' },
  { href: '/ai-settings',       label: 'Persona',    icon: '🤖' },
  { href: '/knowledge',         label: 'Knowledge',  icon: '📚' },
  { href: '/reply-templates',   label: 'Templates',  icon: '📝' },
  { href: '/tags',              label: 'Tags',       icon: '🏷️' },
  { href: '/promos',            label: 'Promo',      icon: '🎁' },
  { href: '/sql-queries',       label: 'SQL',        icon: '🗄' },
  { href: '/users',             label: 'Users',      icon: '👤' },
  { href: '/snippets',          label: 'Snippets',   icon: '✂️' },
  { href: '/channel-settings',  label: 'Channel',    icon: '🔌', adminOnly: true },
];

function isActive(pathname, href) {
  if (pathname === href) return true;
  if (href === '/inbox' && pathname === '/inbox') return true;
  if (href === '/inbox' && pathname.startsWith('/inbox/')) return true;
  if (href === '/lotus-inbox' && pathname.startsWith('/lotus-inbox')) return true;
  return false;
}

export default function Layout({ children, title = 'Tiara CRM' }) {
  const router = useRouter();
  const { user, isLoading, unauthenticated } = useUser({ redirectTo: '/login' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Desktop sidebar: persist collapsed state
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('tiara_sidebar_open') : null;
    if (saved === '0') setSidebarOpen(false);
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('tiara_sidebar_open', sidebarOpen ? '1' : '0');
  }, [sidebarOpen]);

  // Cmd/Ctrl+K opens search globally
  useEffect(() => {
    function handler(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      // Cmd/Ctrl+B toggles sidebar (desktop convention)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Close mobile drawer on route change
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

  const visibleNav = navItems.filter((it) => !it.adminOnly || user?.role === 'admin');

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* Mobile burger */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Buka menu"
              className="md:hidden w-10 h-10 inline-flex items-center justify-center rounded-md text-slate-700 hover:bg-slate-100"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            {/* Desktop sidebar toggle */}
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? 'Sembunyikan menu' : 'Tampilkan menu'}
              title={`${sidebarOpen ? 'Sembunyikan' : 'Tampilkan'} menu (⌘B)`}
              className="hidden md:inline-flex w-9 h-9 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100"
            >
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            <Link href="/inbox" className="font-semibold text-slate-800 truncate text-sm sm:text-base">
              Tiara CRM
            </Link>
          </div>

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
              {user.username} <span className="text-slate-400">({user.role})</span>
            </span>
            <a
              href="/admin/waha-sessions.html"
              className="hidden md:inline-flex w-9 h-9 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              title="WAHA session admin"
              aria-label="WAHA session admin"
            >
              ⚙
            </a>
            <button
              onClick={logout}
              className="hidden md:inline text-sm text-slate-500 hover:text-rose-600 px-2 py-1.5"
              title="Logout"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Body: desktop sidebar + main */}
      <div className="flex-1 flex min-h-0">
        {/* Desktop sidebar */}
        <aside
          className={`hidden md:flex flex-col bg-white border-r border-slate-200 sticky top-[49px] self-start transition-[width] duration-150 ease-out overflow-hidden ${
            sidebarOpen ? 'w-56' : 'w-0'
          }`}
          style={{ height: 'calc(100vh - 49px)' }}
          aria-hidden={!sidebarOpen}
        >
          <nav className="flex-1 overflow-y-auto py-3 px-2 min-w-[14rem]">
            {visibleNav.map((item) => {
              const active = isActive(router.pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-0.5 transition ${
                    active
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span aria-hidden className="w-5 text-center text-base leading-none">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-slate-200 px-2 py-2 min-w-[14rem]">
            <a href="/admin/waha-sessions.html"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-slate-600 hover:bg-slate-100">
              <span aria-hidden className="w-5 text-center">⚙</span>
              <span className="truncate">WAHA Sessions</span>
            </a>
          </div>
        </aside>

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
              {/* Gradient header (Mitra style) */}
              <div className="drawer-gradient px-5 py-5 text-white">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-white/20 grid place-items-center text-lg">🌸</div>
                    <span className="font-extrabold text-lg tracking-tight">Tiara CRM</span>
                  </div>
                  <button
                    onClick={() => setDrawerOpen(false)}
                    aria-label="Tutup menu"
                    className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-white/90 hover:bg-white/15"
                  >✕</button>
                </div>
                <div className="mt-3 text-[13px] text-white/90 truncate">
                  <div className="font-semibold">{user.username}</div>
                  <div className="opacity-80 text-[11px] uppercase tracking-wide">{user.role}</div>
                </div>
              </div>
              <nav className="flex-1 py-2 overflow-y-auto">
                {visibleNav.map((item) => {
                  const active = isActive(router.pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-3 px-4 py-2.5 text-sm transition ${
                        active
                          ? 'bg-violet-50 text-violet-700 font-semibold border-l-4 border-violet-600 pl-3'
                          : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span aria-hidden className="w-5 text-center text-base">{item.icon}</span>
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
                <div className="border-t border-slate-100 mt-2 pt-1">
                  <a href="/admin/waha-sessions.html"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                    <span className="w-5 text-center">⚙</span>
                    <span>WAHA Sessions</span>
                  </a>
                </div>
              </nav>
              <div className="px-4 py-3 border-t border-slate-200">
                <button
                  onClick={() => { setDrawerOpen(false); logout(); }}
                  className="w-full text-sm text-rose-600 px-3 py-2.5 rounded-lg hover:bg-rose-50 font-medium flex items-center justify-center gap-2"
                >
                  <span>↪</span> Logout
                </button>
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto has-bottom-nav md:!pb-0">
          <title>{title}</title>
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-white border-t border-slate-200 flex justify-around items-center px-2 pt-1.5"
        style={{ paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))' }}
      >
        {[
          { href: '/lotus-inbox', label: 'Inbox', icon: '🪷' },
          { href: '/customer',    label: 'Customer', icon: '🎫' },
          { href: '/pipeline',    label: 'Pipeline', icon: '📊' },
          { href: '/ai-monitor',  label: 'AI', icon: '🤖' },
        ].map((it) => {
          const active = isActive(router.pathname, it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-1 rounded-md text-[10px] font-semibold ${
                active ? 'text-violet-700' : 'text-slate-500'
              }`}
            >
              <span className="text-lg leading-none">{it.icon}</span>
              <span>{it.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 py-1 rounded-md text-[10px] font-semibold text-slate-500"
          aria-label="Menu lainnya"
        >
          <span className="text-lg leading-none">☰</span>
          <span>Lainnya</span>
        </button>
      </nav>

      <MessageSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
