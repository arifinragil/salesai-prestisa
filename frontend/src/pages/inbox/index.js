import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { formatRelative, truncate, convStatusLabel, formatPhone } from '@/lib/format';

const STATUS_FILTERS = [
  { value: '',       label: 'Semua' },
  { value: 'active', label: 'Aktif' },
  { value: 'closed', label: 'Closed' },
  { value: 'spam',   label: 'Spam' },
];

export default function InboxList() {
  const [status, setStatus] = useState('');
  const [waSession, setWaSession] = useState('');
  const [search, setSearch] = useState('');
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
      'crm:conv-updated': () => mutate(),
      'crm:handover':     () => mutate(),
    },
    { joinRooms: [{ event: 'crm:join-inbox' }] }
  );

  const items = data?.items || [];

  return (
    <Layout title="Inbox — Tiara">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-slate-800">Inbox</h1>
          <div className="text-xs text-slate-500">
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
                            {formatPhone(conv.phone)}
                          </span>
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
