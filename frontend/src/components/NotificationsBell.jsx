import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { formatRelative } from '@/lib/format';

const KIND_ICON = {
  task_assigned: '📋',
  task_due: '⏰',
  task_overdue: '🚨',
  mention: '💬',
};

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const count = useSWR('/api/users/me/notifications/unread-count', fetcher, { refreshInterval: 30_000 });
  const list = useSWR(open ? '/api/users/me/notifications?limit=10' : null, fetcher);

  async function markRead(id, link) {
    await api(`/api/users/me/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setOpen(false);
    count.mutate();
    list.mutate();
    if (link) router.push(link);
  }
  async function markAll() {
    await api('/api/users/me/notifications/read-all', { method: 'POST' });
    count.mutate();
    list.mutate();
  }

  const unread = count.data?.count || 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex items-center justify-center w-9 h-9 rounded hover:bg-slate-100"
        aria-label="Notifikasi"
      >
        <span aria-hidden className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute top-0 right-0 inline-flex items-center justify-center text-[9px] font-semibold rounded-full bg-rose-500 text-white min-w-[16px] h-4 px-1">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <button type="button" onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-transparent" />
          <div className="absolute right-0 top-11 z-50 w-80 bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-800">Notifikasi</span>
              {unread > 0 && (
                <button onClick={markAll} className="text-[11px] text-brand-600 hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {!list.data && <div className="px-3 py-4 text-sm text-slate-400">Loading…</div>}
              {(list.data?.items || []).length === 0 && (
                <div className="px-3 py-6 text-sm text-slate-400 text-center">Tidak ada notifikasi.</div>
              )}
              {(list.data?.items || []).map((n) => (
                <button
                  key={n.id}
                  onClick={() => markRead(n.id, n.link)}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 ${!n.read_at ? 'bg-amber-50' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    <span aria-hidden>{KIND_ICON[n.kind] || '🔔'}</span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-slate-800 ${!n.read_at ? 'font-semibold' : ''}`}>{n.title}</div>
                      {n.body && <div className="text-slate-500 line-clamp-2 mt-0.5">{n.body}</div>}
                      <div className="text-[10px] text-slate-400 mt-1">{formatRelative(n.created_at)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
