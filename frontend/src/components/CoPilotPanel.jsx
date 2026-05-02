import { useEffect, useState, useCallback } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { useSocket } from '@/lib/useSocket';

export default function CoPilotPanel({ conversationId, onUseSuggestion, leadTemp }) {
  const toast = useToast();
  const swrKey = conversationId
    ? `/api/inbox/conversations/${conversationId}/suggestions/latest`
    : null;
  const { data, mutate, isLoading } = useSWR(swrKey, fetcher, { refreshInterval: 0 });
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sug = data?.suggestion;
  const opts = sug?.options || [];

  // Live refresh on socket events scoped to this conversation room
  useSocket(
    {
      'suggestion:new': (p) => {
        if (String(p.conversation_id) === String(conversationId)) mutate();
      },
      'suggestion:used': () => mutate(),
    },
    { joinRooms: conversationId ? [{ event: 'crm:join-conv', arg: parseInt(conversationId, 10) }] : [] }
  );

  // Keyboard shortcuts: 1-4 use, R regenerate
  useEffect(() => {
    function onKey(e) {
      const tag = e.target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (['1', '2', '3', '4'].includes(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (opts[idx]) handleUse(opts[idx]);
      } else if (e.key === 'r' || e.key === 'R') {
        handleRegenerate();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  const handleUse = useCallback(
    (opt) => {
      if (sug?.usage_type) {
        toast.info('Sudah digunakan operator lain');
        return;
      }
      onUseSuggestion?.({ logId: sug.id, rank: opt.rank, text: opt.text, source: opt.source });
    },
    [sug, onUseSuggestion, toast]
  );

  const handleRegenerate = useCallback(async () => {
    if (busy || !conversationId) return;
    setBusy(true);
    try {
      await api(`/api/inbox/conversations/${conversationId}/suggestions/regenerate`, { method: 'POST' });
      await mutate();
    } catch (e) {
      toast.error(e?.message || 'Gagal regenerate');
    } finally {
      setBusy(false);
    }
  }, [conversationId, busy, mutate, toast]);

  const handleFlag = async (reason) => {
    if (!sug) return;
    try {
      await api(`/api/inbox/conversations/${conversationId}/suggestions/${sug.id}/flag`, {
        method: 'POST',
        body: { reason },
      });
      toast.success('Flag tersimpan, terima kasih');
    } catch (e) {
      toast.error(e?.message || 'Gagal flag');
    }
  };

  async function handleGenerate() {
    if (busy || !conversationId) return;
    setBusy(true);
    try {
      await api(`/api/inbox/conversations/${conversationId}/suggestions/generate`, { method: 'POST' });
      await mutate();
    } catch (e) {
      toast.error(e?.message || 'Gagal generate');
    } finally {
      setBusy(false);
    }
  }

  if (!conversationId) return null;
  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-slate-400">Loading suggestion…</div>;
  }
  if (!sug) {
    // No suggestion yet for this conv — manual trigger to save tokens.
    return (
      <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-xs text-slate-500">🤖 Co-Pilot siap — klik untuk generate suggestion</span>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-300"
        >
          {busy ? 'Generating…' : '✨ Generate'}
        </button>
      </div>
    );
  }

  const lowConf = opts.some((o) => o.confidence === 'low');

  return (
    <div className="border-t border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-slate-600 hover:bg-slate-100"
      >
        <span>
          🤖 Co-Pilot · {opts.length} suggestion · {sug.generation_ms}ms
        </span>
        <span>{collapsed ? '▾' : '▴'}</span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {leadTemp === 'hot' && (
            <div className="text-xs px-2 py-1 bg-rose-50 border border-rose-200 rounded text-rose-700 font-medium">
              🔥 Hot lead — close ASAP
            </div>
          )}
          {lowConf && (
            <div className="text-xs px-2 py-1 bg-amber-50 border border-amber-200 rounded text-amber-800">
              🔍 Konteks belum jelas — review extra hati-hati
            </div>
          )}
          {sug.usage_type && (
            <div className="text-xs px-2 py-1 bg-slate-100 border border-slate-200 rounded text-slate-600">
              ✓ Sudah digunakan: opsi #{sug.picked_rank} ({sug.usage_type})
            </div>
          )}
          {opts.map((o) => (
            <div
              key={o.rank}
              className={`bg-white border rounded p-2 ${
                sug.usage_type ? 'opacity-50' : 'border-slate-200 hover:border-brand-400'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-500">
                  {o.rank}️⃣ {o.source === 'ai' ? '✨ AI' : o.case_label || o.source}
                </span>
                <button
                  type="button"
                  disabled={!!sug.usage_type}
                  onClick={() => handleUse(o)}
                  className="text-xs px-2 py-0.5 rounded bg-brand-500 text-white disabled:bg-slate-300"
                >
                  Use [{o.rank}]
                </button>
              </div>
              <div className="text-sm text-slate-800 whitespace-pre-wrap">{o.text}</div>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={handleRegenerate}
              className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50"
            >
              🔄 Regenerate [R]
            </button>
            <select
              onChange={(e) => {
                if (e.target.value) handleFlag(e.target.value);
                e.target.value = '';
              }}
              className="text-xs px-2 py-1 rounded border border-slate-300"
              defaultValue=""
            >
              <option value="">🚩 Flag…</option>
              <option value="off_tone">Off-tone</option>
              <option value="wrong">Wrong</option>
              <option value="irrelevant">Irrelevant</option>
              <option value="harmful">Harmful</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
