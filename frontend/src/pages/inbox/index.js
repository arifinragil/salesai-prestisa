import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useNotifPermission, useNotificationSound, showBrowserNotification } from '@/lib/useNotifications';
import { formatRelative, truncate, convStatusLabel, formatPhone } from '@/lib/format';

const TAG_COLOR = {
  slate:'bg-slate-100 text-slate-700 border-slate-200',
  rose:'bg-rose-100 text-rose-700 border-rose-200',
  amber:'bg-amber-100 text-amber-800 border-amber-200',
  emerald:'bg-emerald-100 text-emerald-700 border-emerald-200',
  sky:'bg-sky-100 text-sky-700 border-sky-200',
  indigo:'bg-indigo-100 text-indigo-700 border-indigo-200',
  violet:'bg-violet-100 text-violet-700 border-violet-200',
  pink:'bg-pink-100 text-pink-700 border-pink-200',
};

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
  const [queue, setQueue] = useState('');
  const [tagId, setTagId] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const playSound = useNotificationSound();
  const notif = useNotifPermission();
  const seenConvIds = useRef(new Set());
  const firstLoadRef = useRef(true);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (waSession) params.set('wa_session', waSession);
  if (search) params.set('search', search);
  if (queue) params.set('queue', queue);
  if (tagId) params.set('tag_id', tagId);
  const url = `/api/inbox/conversations${params.toString() ? '?' + params.toString() : ''}`;
  const sessions = useSWR('/api/inbox/wa-sessions', fetcher, { refreshInterval: 60_000 });
  const tags = useSWR('/api/ops/tags', fetcher, { refreshInterval: 120_000 });

  async function bulk(action, extra = {}) {
    if (!selected.size) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/inbox/conversations/bulk', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected), action, ...extra }),
      });
      if (!r.ok) throw new Error((await r.json()).message || 'bulk failed');
      setSelected(new Set());
      mutate();
    } catch (err) { alert(err.message); }
    finally { setBulkBusy(false); }
  }
  function toggleSelect(id, e) {
    e.preventDefault(); e.stopPropagation();
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

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
          <select
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
            className="px-3 py-1.5 text-sm border border-slate-200 rounded-md bg-white"
          >
            <option value="">Semua queue</option>
            <option value="mine">Queue saya</option>
            <option value="unassigned">Belum diambil</option>
          </select>
          {(tags.data?.items || []).length > 0 && (
            <select
              value={tagId}
              onChange={(e) => setTagId(e.target.value)}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-md bg-white"
            >
              <option value="">Semua tag</option>
              {tags.data.items.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.conv_count})</option>
              ))}
            </select>
          )}
        </div>

        {selected.size > 0 && (
          <div className="bg-brand-50 border border-brand-200 rounded-md px-3 py-2 mb-3 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-brand-800 font-medium">{selected.size} dipilih</span>
            <button onClick={() => bulk('close')} disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
              Close
            </button>
            <button onClick={() => bulk('reopen')} disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
              Reopen
            </button>
            <button onClick={() => bulk('shadow_on')} disabled={bulkBusy}
              className="text-xs px-3 py-1 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
              Shadow ON
            </button>
            {(tags.data?.items || []).length > 0 && (
              <select
                disabled={bulkBusy}
                onChange={(e) => { if (e.target.value) bulk('tag', { tag_id: parseInt(e.target.value) }); e.target.value = ''; }}
                className="text-xs px-3 py-1 rounded bg-white border border-slate-200"
                defaultValue=""
              >
                <option value="">+ Tag…</option>
                {tags.data.items.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <button onClick={() => setSelected(new Set())}
              className="text-xs px-3 py-1 rounded text-slate-500 hover:text-slate-700 ml-auto">
              Batal pilih
            </button>
          </div>
        )}

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
                <li key={conv.id} className="flex items-stretch">
                  <button
                    type="button"
                    onClick={(e) => toggleSelect(conv.id, e)}
                    aria-label={selected.has(conv.id) ? 'Unselect' : 'Select'}
                    className={`px-3 flex items-center justify-center border-r border-slate-100 transition ${
                      selected.has(conv.id) ? 'bg-brand-50 text-brand-700' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <span className="w-4 h-4 inline-flex items-center justify-center rounded border border-slate-300 text-xs">
                      {selected.has(conv.id) ? '✓' : ''}
                    </span>
                  </button>
                  <Link
                    href={`/inbox/${conv.id}`}
                    className="block flex-1 px-4 py-3 hover:bg-slate-50 transition"
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
                        {Array.isArray(conv.tags) && conv.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {conv.tags.map((t) => (
                              <span
                                key={t.id}
                                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] border ${TAG_COLOR[t.color] || TAG_COLOR.slate}`}
                                title={t.auto ? 'Auto-tagged oleh AI (intent classifier)' : undefined}
                              >
                                {t.auto && <span aria-hidden className="opacity-70">✨</span>}
                                {t.name}
                              </span>
                            ))}
                          </div>
                        )}
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
