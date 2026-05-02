import { useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { useToast } from './Toast';
import { formatRelative } from '@/lib/format';
import MentionAutocomplete from './MentionAutocomplete';

export default function InternalCommentsBlock({ convId }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const { data, mutate } = useSWR(
    convId ? `/api/inbox/conversations/${convId}/comments` : null,
    fetcher,
    { refreshInterval: 30_000 }
  );

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await api(`/api/inbox/conversations/${convId}/comments`, { method: 'POST', body: { body } });
      setDraft('');
      mutate();
    } catch (err) { toast.error('Gagal kirim: ' + err.message); }
    finally { setSending(false); }
  }

  const items = data?.items || [];
  return (
    <section className="space-y-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
        💬 Internal comments ({items.length})
      </div>
      <div className="bg-white rounded-md border border-slate-200 max-h-64 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-3 py-3 text-xs text-slate-400 text-center">
            Belum ada komentar internal.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((c) => (
              <li key={c.id} className="px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-slate-700">
                    {c.full_name || c.username || '?'}
                  </span>
                  <span className="text-[10px] text-slate-400">{formatRelative(c.created_at)}</span>
                </div>
                <div className="text-slate-700 whitespace-pre-wrap mt-0.5">
                  {renderMentions(c.body)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <MentionAutocomplete
        value={draft}
        onChange={setDraft}
        placeholder="Tulis komentar internal… (@nama untuk tag)"
        rows={2}
      />
      <button
        onClick={send}
        disabled={sending || !draft.trim()}
        className="w-full text-xs px-2 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50"
      >
        {sending ? 'Mengirim…' : '📨 Kirim komentar'}
      </button>
    </section>
  );
}

function renderMentions(text) {
  // Highlight @username tokens
  const parts = String(text).split(/(@[a-zA-Z0-9._-]+)/g);
  return parts.map((p, i) =>
    /^@[a-zA-Z0-9._-]+$/.test(p)
      ? <span key={i} className="bg-brand-50 text-brand-700 rounded px-1">{p}</span>
      : <span key={i}>{p}</span>
  );
}
