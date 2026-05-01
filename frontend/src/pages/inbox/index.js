import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useNotifPermission, useNotificationSound, showBrowserNotification } from '@/lib/useNotifications';
import { formatRelative, truncate, convStatusLabel, formatPhone } from '@/lib/format';

const STATUS_FILTERS = [
  { value: '',       label: 'Semua' },
  { value: 'active', label: 'Aktif' },
  { value: 'closed', label: 'Closed' },
  { value: 'spam',   label: 'Spam' },
];

export default function InboxList() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [waSession, setWaSession] = useState('');
  const [search, setSearch] = useState('');
  const playSound = useNotificationSound();
  const notif = useNotifPermission();
  const seenConvIds = useRef(new Set());
  const firstLoadRef = useRef(true);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (waSession) params.set('wa_session', waSession);
  if (search) params.set('search', search);
  const url = `/api/inbox/conversations${params.toString() ? '?' + params.toString() : ''}`;
  const sessions = useSWR('/api/inbox/wa-sessions', fetcher, { refreshInterval: 60_000 });

  const { data, error, isLoading, mutate } = useSWR(url, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });

  // Live update on inbox events — re-fetch the list
  useSocket(
    {
      'crm:conv-updated': (payload) => {
        mutate();
        // Sound + notification only after initial render and only for non-self triggers
        if (!firstLoadRef.current && payload?.conversation_id) {
          const isNewConv = !seenConvIds.current.has(payload.conversation_id);
          if (isNewConv) {
            playSound({ frequency: 720, duration: 0.18 });
            showBrowserNotification({
              title: 'Pesan baru di inbox',
              body: `Conv #${payload.conversation_id}`,
              tag: `conv-${payload.conversation_id}`,
              onClick: () => router.push(`/inbox/${payload.conversation_id}`),
            });
          }
          seenConvIds.current.add(payload.conversation_id);
        }
      },
      'crm:handover': (payload) => {
        mutate();
        if (!firstLoadRef.current) {
          playSound({ frequency: 440, duration: 0.32, type: 'square' });
          showBrowserNotification({
            title: '⚠️ Handover butuh operator',
            body: `${payload?.reason || 'tool_error'} · ${payload?.summary?.slice(0, 80) || ''}`,
            tag: `ho-${payload?.conversation_id || ''}`,
            onClick: () => router.push(`/inbox/${payload?.conversation_id}`),
          });
        }
      },
    },
    { joinRooms: [{ event: 'crm:join-inbox' }] }
  );

  const items = data?.items || [];

  // Track seen conv IDs so we know what's "new" on subsequent updates
  useEffect(() => {
    if (data?.items) {
      data.items.forEach((c) => seenConvIds.current.add(c.id));
      firstLoadRef.current = false;
    }
  }, [data?.items]);

  return (
    <Layout title="Inbox — Tiara">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-slate-800">Inbox</h1>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {notif.supported && notif.state !== 'granted' && (
              <button
                onClick={notif.request}
                className="text-xs px-2.5 py-1 rounded-md text-brand-700 border border-brand-200 bg-brand-50 hover:bg-brand-100"
                title="Aktifkan notifikasi browser untuk pesan baru"
              >
                🔔 Enable notif
              </button>
            )}
            {isLoading ? 'Loading…' : `${items.length} percakapan`}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <input
            type="search"
            placeholder="Cari nomor (62…)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-brand-500"
          />
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatus(f.value)}
                className={`px-3 py-1.5 text-sm rounded-md transition ${
                  status === f.value
                    ? 'bg-brand-500 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {(sessions.data?.items || []).length > 0 && (
            <select
              value={waSession}
              onChange={(e) => setWaSession(e.target.value)}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-brand-500 bg-white"
            >
              <option value="">Semua nomor WA</option>
              {sessions.data.items.map((s) => (
                <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2 mb-4">
            {error.message || 'Gagal memuat'}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {items.length === 0 && !isLoading && (
            <div className="px-6 py-12 text-center text-sm text-slate-400">
              Belum ada percakapan.
            </div>
          )}
          <ul className="divide-y divide-slate-100">
            {items.map((conv) => {
              const status = convStatusLabel(conv);
              return (
                <li key={conv.id}>
                  <Link
                    href={`/inbox/${conv.id}`}
                    className="block px-4 py-3 hover:bg-slate-50 transition"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-slate-800">
                            {formatPhone(conv.real_phone || conv.phone)}
                          </span>
                          {conv.push_name && (
                            <span className="text-xs text-slate-500 truncate max-w-[120px]" title={conv.push_name}>
                              {conv.push_name}
                            </span>
                          )}
                          <span className={`status-pill ${status.cls}`}>
                            {status.label}
                          </span>
                          {conv.last_intent && (
                            <span className="text-xs text-slate-400">
                              · {conv.last_intent}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-slate-500 mt-0.5 truncate">
                          {conv.last_sender === 'customer' ? '' : '↗ '}
                          {truncate(conv.last_body || '(no message)', 90)}
                        </div>
                      </div>
                      <div className="text-xs text-slate-400 whitespace-nowrap">
                        {formatRelative(conv.last_at || conv.last_message_at)}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Layout>
  );
}
