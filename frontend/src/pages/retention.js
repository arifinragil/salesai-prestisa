import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative, formatPhone } from '@/lib/format';

const KIND_LABEL = {
  dormant_warm: { label: 'Dormant 30d (warm)', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  dormant_cold: { label: 'Dormant 60d (cold)', color: 'bg-orange-100 text-orange-700 border-orange-200' },
  dormant_dead: { label: 'Dormant 90d (dead)', color: 'bg-rose-100 text-rose-700 border-rose-200' },
  winback:      { label: 'Win-back lost',       color: 'bg-purple-100 text-purple-700 border-purple-200' },
  moment_birthday:    { label: '🎂 Birthday',     color: 'bg-pink-100 text-pink-700 border-pink-200' },
  moment_anniversary: { label: '💐 Anniversary', color: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200' },
};

export default function RetentionReviewPage() {
  const toast = useToast();
  const me = useSWR('/api/auth/me', fetcher);
  const counts = useSWR('/api/retention/counts', fetcher, { refreshInterval: 30_000 });
  const [filterKind, setFilterKind] = useState('');
  const list = useSWR(`/api/retention/pending${filterKind ? `?kind=${filterKind}` : ''}`, fetcher, { refreshInterval: 30_000 });
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const isAdmin = me.data?.user?.role === 'admin';
  if (me.data && !isAdmin) {
    return <Layout title="Retention"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  const items = list.data?.items || [];
  const countItems = counts.data?.items || [];
  const totalPending = countItems.reduce((s, x) => s + x.n, 0);

  function toggleSelect(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function approveSelected() {
    if (!selected.size) return;
    setBusy(true);
    try {
      const r = await api('/api/retention/approve', { method: 'POST', body: { ids: [...selected] } });
      toast.success(`Approved ${r.updated} followup`);
      setSelected(new Set());
      list.mutate(); counts.mutate();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  async function rejectSelected() {
    if (!selected.size) return;
    if (!confirm(`Reject ${selected.size} followup permanen?`)) return;
    setBusy(true);
    try {
      const r = await api('/api/retention/reject', { method: 'POST', body: { ids: [...selected] } });
      toast.success(`Rejected ${r.updated}`);
      setSelected(new Set());
      list.mutate(); counts.mutate();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  async function approveAllOfKind(kind) {
    if (!confirm(`Approve SEMUA ${kind} pending? Akan langsung schedule kirim WA dalam 5 menit.`)) return;
    setBusy(true);
    try {
      const r = await api('/api/retention/approve', { method: 'POST', body: { all_kind: kind } });
      toast.success(`Approved ${r.updated} ${kind}`);
      list.mutate(); counts.mutate();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  async function runEngine() {
    if (!confirm('Generate retention followups baru sekarang? (Semua akan paused untuk review)')) return;
    setBusy(true);
    try {
      const r = await api('/api/retention/run', { method: 'POST' });
      toast.success(`Generated: dormant ${r.dormant}, winback ${r.winback}, moments ${r.moments}`);
      list.mutate(); counts.mutate();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <Layout title="Retention review — Tiara">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Retention review</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {totalPending} pending followup. Approve untuk schedule kirim WA dalam 5 menit.
            </p>
          </div>
          <button onClick={runEngine} disabled={busy}
            className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
            ⚡ Generate sekarang
          </button>
        </div>

        {/* Counts per kind + bulk approve */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <button onClick={() => setFilterKind('')}
            className={`text-left px-3 py-2 border rounded-lg ${!filterKind ? 'bg-slate-100 border-slate-300' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
            <div className="text-xs text-slate-500">All</div>
            <div className="text-lg font-semibold text-slate-800">{totalPending}</div>
          </button>
          {countItems.map((c) => {
            const meta = KIND_LABEL[c.kind] || { label: c.kind, color: 'bg-slate-100' };
            return (
              <div key={c.kind} className={`border rounded-lg ${filterKind === c.kind ? 'border-slate-400 ring-2 ring-slate-200' : 'border-slate-200'}`}>
                <button onClick={() => setFilterKind(c.kind)} className="w-full text-left px-3 py-2 hover:bg-slate-50">
                  <div className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${meta.color}`}>{meta.label}</div>
                  <div className="text-lg font-semibold text-slate-800 mt-0.5">{c.n}</div>
                </button>
                <button onClick={() => approveAllOfKind(c.kind)} disabled={busy}
                  className="w-full text-[11px] px-2 py-1 border-t border-slate-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
                  ✓ Approve all
                </button>
              </div>
            );
          })}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 flex items-center gap-2 sticky top-[49px] z-10">
            <span className="text-sm text-brand-800 font-medium">{selected.size} dipilih</span>
            <button onClick={approveSelected} disabled={busy}
              className="text-xs px-2 py-1 rounded bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
              ✓ Approve
            </button>
            <button onClick={rejectSelected} disabled={busy}
              className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
              ✕ Reject
            </button>
            <button onClick={() => setSelected(new Set())}
              className="text-xs px-2 py-1 text-slate-500 hover:bg-slate-100 rounded">Clear</button>
          </div>
        )}

        {/* List */}
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {items.length === 0
            ? <div className="px-3 py-12 text-center text-sm text-slate-400">No pending followup{filterKind ? ` untuk ${filterKind}` : ''}</div>
            : items.map((it) => {
                const meta = KIND_LABEL[it.kind] || { label: it.kind, color: 'bg-slate-100' };
                const isSel = selected.has(it.id);
                return (
                  <div key={it.id} className={`px-3 py-2 flex items-start gap-2 ${isSel ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                    <input type="checkbox" checked={isSel} onChange={() => toggleSelect(it.id)} className="mt-1" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span className="font-medium text-slate-800">{it.push_name || formatPhone(it.real_phone || it.phone)}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.color}`}>{meta.label}</span>
                        {it.customer_id && <span className="text-[10px] text-slate-400">cust #{it.customer_id}</span>}
                        {it.promo_code && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-mono">{it.promo_code}</span>}
                        <span className="text-[10px] text-slate-400">· {formatRelative(it.created_at)}</span>
                      </div>
                      <div className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{it.body_template}</div>
                    </div>
                  </div>
                );
              })}
        </div>
      </div>
    </Layout>
  );
}
