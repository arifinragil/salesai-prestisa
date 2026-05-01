import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { formatRelative, formatPhone, truncate } from '@/lib/format';

export default function MessageSearch({ open, onClose }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setDebounced('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handler(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const url = debounced.length >= 2
    ? `/api/inbox/messages/search?q=${encodeURIComponent(debounced)}&limit=30`
    : null;
  const { data, error, isLoading } = useSWR(url, fetcher, { keepPreviousData: true });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Cari pesan"
    >
      <div
        className="absolute left-1/2 top-20 -translate-x-1/2 w-full max-w-2xl bg-white rounded-xl shadow-2xl border border-slate-200 max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 p-3">
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari isi pesan atau nomor (62…)"
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:border-brand-500"
          />
          <div className="text-[11px] text-slate-400 mt-1.5 px-1">
            Esc untuk tutup · ↵ klik hasil untuk buka chat
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {debounced.length < 2 && (
            <div className="text-sm text-slate-400 text-center py-12">
              Ketik minimal 2 karakter…
            </div>
          )}
          {error && (
            <div className="text-sm text-rose-600 text-center py-6">{error.message}</div>
          )}
          {debounced.length >= 2 && isLoading && !data && (
            <div className="text-sm text-slate-400 text-center py-6">Mencari…</div>
          )}
          {data && data.results.length === 0 && (
            <div className="text-sm text-slate-400 text-center py-6">
              Tidak ada hasil untuk &quot;{data.query}&quot;
            </div>
          )}
          {data && data.results.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {data.results.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/inbox/${r.conversation_id}#m${r.id}`}
                    onClick={onClose}
                    className="block px-3 py-2 hover:bg-slate-50 rounded-md"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500 mb-0.5">
                      <span className="font-mono">{formatPhone(r.phone)}</span>
                      <span>{formatRelative(r.created_at)}</span>
                    </div>
                    <div className="text-sm text-slate-700">
                      <span className="text-slate-400 mr-1">{r.direction === 'in' ? '←' : '→'} {r.sender_type}:</span>
                      {highlightMatch(truncate(r.body || '(no text)', 160), debounced)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function highlightMatch(text, q) {
  if (!q) return text;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  const parts = String(text).split(re);
  return parts.map((p, i) =>
    re.test(p) ? <mark key={i} className="bg-yellow-100 text-yellow-900 rounded-sm">{p}</mark> : p
  );
}
