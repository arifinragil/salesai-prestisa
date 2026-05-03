import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative } from '@/lib/format';

const STATUS_BADGE = {
  draft:     'bg-slate-100 text-slate-700 border-slate-200',
  active:    'bg-emerald-100 text-emerald-700 border-emerald-200',
  paused:    'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
  completed: 'bg-sky-100 text-sky-700 border-sky-200',
};

export default function B2BOutreachPage() {
  const router = useRouter();
  const toast = useToast();
  const me = useSWR('/api/auth/me', fetcher);
  const list = useSWR('/api/b2b/campaigns', fetcher, { refreshInterval: 30_000 });
  const [creating, setCreating] = useState(false);

  const isAdmin = me.data?.user?.role === 'admin';
  if (me.data && !isAdmin) {
    return <Layout title="B2B Outreach"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  return (
    <Layout title="B2B Outreach — Tiara">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">B2B Outreach Campaigns</h1>
            <p className="text-xs text-slate-500 mt-0.5">Sequenced WA outreach untuk B2B customer.</p>
          </div>
          <button onClick={() => setCreating(true)}
            className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600">
            + Campaign baru
          </button>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Campaign</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-right">Steps</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right">Replied</th>
                  <th className="px-3 py-2 text-right">Opted-out</th>
                  <th className="px-3 py-2 text-right">Done</th>
                  <th className="px-3 py-2 text-left">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(list.data?.items || []).map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link href={`/b2b-outreach/${c.id}`} className="text-brand-700 hover:underline font-medium">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_BADGE[c.status] || STATUS_BADGE.draft}`}>{c.status}</span>
                    </td>
                    <td className="px-3 py-2 text-right">{c.step_count}</td>
                    <td className="px-3 py-2 text-right font-medium">{c.total}</td>
                    <td className="px-3 py-2 text-right text-emerald-600">{c.replied}</td>
                    <td className="px-3 py-2 text-right text-rose-500">{c.opted_out}</td>
                    <td className="px-3 py-2 text-right text-slate-500">{c.completed}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{formatRelative(c.created_at)}</td>
                  </tr>
                ))}
                {list.data?.items?.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">Belum ada campaign</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {creating && <CreateCampaignModal onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); router.push(`/b2b-outreach/${id}`); }} />}
    </Layout>
  );
}

function CreateCampaignModal({ onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [filters, setFilters] = useState({ customer_type: 'b2b', last_buy_from: '', last_buy_to: '', total_spent_min: '' });
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [steps, setSteps] = useState([
    { delay_days: 0, body_template: '{greet} 🌹 Tiara dari Prestisa. Kalau Bapak/Ibu lagi butuh karangan bunga / parsel / cake untuk acara perusahaan, kami siap bantu — pengalaman handle 1000+ event. Boleh kami kirim katalog?' },
    { delay_days: 3, body_template: '{greet} mengingatkan saja — kalau ada acara kantor minggu depan/bulan depan, kami punya paket khusus B2B dengan PO + invoice. Coba liat dulu yuk?' },
    { delay_days: 7, body_template: '{greet} terakhir nih — kalau memang belum butuh, no worries. Kami simpan kontak Bapak/Ibu, semoga lain waktu bisa kerja sama 🙏' },
  ]);
  const [submitting, setSubmitting] = useState(false);

  async function doPreview() {
    setPreviewing(true);
    try {
      const r = await api('/api/b2b/preview', { method: 'POST', body: filters });
      setPreview(r);
    } catch (e) { toast.error(e.message); }
    finally { setPreviewing(false); }
  }

  function updateStep(idx, patch) {
    setSteps((arr) => arr.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }

  async function submit() {
    if (!name.trim()) return toast.error('Nama campaign wajib');
    if (!preview?.items?.length) return toast.error('Preview prospect dulu');
    setSubmitting(true);
    try {
      const r = await api('/api/b2b/campaigns', {
        method: 'POST',
        body: { name: name.trim(), sequence: steps, filters, prospects: preview.items },
      });
      toast.success(`Campaign dibuat — ${r.prospects_added} prospects`);
      onCreated(r.campaign_id);
    } catch (e) { toast.error(e.message); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Buat campaign B2B</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Nama campaign</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="mis. Q2-2026 — Korporat Jakarta"
              className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded" />
          </div>

          <div className="border border-slate-200 rounded p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700">Filter prospects</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-500">Order terakhir dari
                <input type="date" value={filters.last_buy_from} onChange={(e) => setFilters({...filters, last_buy_from: e.target.value})}
                  className="w-full px-2 py-1 text-sm border border-slate-200 rounded mt-0.5" />
              </label>
              <label className="text-xs text-slate-500">Order terakhir sampai
                <input type="date" value={filters.last_buy_to} onChange={(e) => setFilters({...filters, last_buy_to: e.target.value})}
                  className="w-full px-2 py-1 text-sm border border-slate-200 rounded mt-0.5" />
              </label>
              <label className="text-xs text-slate-500">Min total spent (Rp)
                <input type="number" value={filters.total_spent_min} onChange={(e) => setFilters({...filters, total_spent_min: e.target.value})}
                  placeholder="mis. 1000000"
                  className="w-full px-2 py-1 text-sm border border-slate-200 rounded mt-0.5" />
              </label>
              <label className="text-xs text-slate-500">Type
                <select value={filters.customer_type} onChange={(e) => setFilters({...filters, customer_type: e.target.value})}
                  className="w-full px-2 py-1 text-sm border border-slate-200 rounded mt-0.5">
                  <option value="b2b">B2B (corporate)</option>
                  <option value="b2c">B2C (personal)</option>
                </select>
              </label>
            </div>
            <button onClick={doPreview} disabled={previewing}
              className="text-xs px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 disabled:opacity-50">
              {previewing ? 'Loading…' : '🔍 Preview prospects'}
            </button>
            {preview && (
              <div className="text-xs text-slate-600">
                <b>{preview.count}</b> prospect ditemukan.
                {preview.count > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-slate-500">Sample 5</summary>
                    <ul className="text-[11px] mt-1 space-y-0.5">
                      {preview.items.slice(0,5).map((p) => (
                        <li key={p.customer_id}>• {p.customer_name} ({p.phone}) — Rp{Number(p.total_spent).toLocaleString('id-ID')}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>

          <div className="border border-slate-200 rounded p-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700">Sequence ({steps.length} steps)</div>
            <p className="text-[11px] text-slate-500">Variabel: <code>{'{greet}'}</code>, <code>{'{name}'}</code>, <code>{'{company}'}</code>. Footer opt-out otomatis ditambah.</p>
            {steps.map((s, idx) => (
              <div key={idx} className="border border-slate-100 rounded p-2 space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold text-slate-700">Step {idx + 1}</span>
                  <label className="text-slate-500">delay (hari setelah step prev):
                    <input type="number" value={s.delay_days} min="0" onChange={(e) => updateStep(idx, { delay_days: parseInt(e.target.value) || 0 })}
                      className="ml-1 w-16 px-2 py-0.5 border border-slate-200 rounded" />
                  </label>
                </div>
                <textarea value={s.body_template} onChange={(e) => updateStep(idx, { body_template: e.target.value })}
                  rows={3} className="w-full text-xs border border-slate-200 rounded p-2" />
              </div>
            ))}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-slate-200">Cancel</button>
          <button onClick={submit} disabled={submitting || !preview?.count}
            className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
            {submitting ? 'Saving…' : `Buat draft (${preview?.count || 0} prospect)`}
          </button>
        </div>
      </div>
    </div>
  );
}
