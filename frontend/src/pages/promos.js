import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import SimpleTable from '@/components/SimpleTable';
import { api, fetcher } from '@/lib/api';

function fmtIDR(n) {
  if (n == null) return null;
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

export default function PromosPage() {
  const { data, mutate } = useSWR('/api/ops/promos', fetcher);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  function blank() {
    const today = new Date().toISOString().slice(0, 10);
    return { code: '', description: '', product_category: '', city: '',
             discount_pct: '', discount_amount: '',
             starts_at: today, ends_at: today, active: true };
  }
  async function save(e) {
    e.preventDefault();
    setError(null);
    const body = { ...editing,
      discount_pct: editing.discount_pct === '' ? null : parseInt(editing.discount_pct),
      discount_amount: editing.discount_amount === '' ? null : parseInt(editing.discount_amount),
    };
    try {
      if (editing.id) await api(`/api/ops/promos/${editing.id}`, { method: 'PUT', body });
      else            await api('/api/ops/promos',          { method: 'POST', body });
      setEditing(null); mutate();
    } catch (err) { setError(err.message); }
  }
  async function remove(id) {
    if (!confirm('Hapus promo ini?')) return;
    try { await api(`/api/ops/promos/${id}`, { method: 'DELETE' }); mutate(); } catch (err) { alert(err.message); }
  }

  const items = data?.items || [];
  return (
    <Layout title="Promo – Tiara CRM">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Promo aktif</h1>
            <p className="text-sm text-slate-500">
              AI baca daftar ini via tool <code>list_active_promos</code>. Promo expired otomatis ter-skip.
            </p>
          </div>
          <button onClick={() => setEditing(blank())}
            className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium">
            + Promo baru
          </button>
        </div>

        <SimpleTable
          columns={[
            { key: 'code', label: 'Code',
              render: (r) => <code className="text-xs bg-slate-100 rounded px-1.5 py-0.5">{r.code}</code> },
            { key: 'description', label: 'Deskripsi' },
            { key: 'product_category', label: 'Kategori', render: (r) => r.product_category || <span className="text-slate-300">semua</span> },
            { key: 'city', label: 'Kota', render: (r) => r.city || <span className="text-slate-300">semua</span> },
            { key: 'discount', label: 'Discount', render: (r) =>
              r.discount_pct ? `${r.discount_pct}%` : (fmtIDR(r.discount_amount) || '—') },
            { key: 'period', label: 'Periode', render: (r) =>
              <span className="text-xs text-slate-600">
                {String(r.starts_at).slice(0,10)} → {String(r.ends_at).slice(0,10)}
              </span> },
            { key: 'active', label: 'Aktif',
              render: (r) => r.active
                ? <span className="text-emerald-600 text-xs">ON</span>
                : <span className="text-slate-400 text-xs">off</span> },
            { key: 'actions', label: '', cellClass: 'text-right whitespace-nowrap',
              render: (r) => (
                <div className="space-x-2">
                  <button onClick={() => setEditing({
                    ...r,
                    starts_at: String(r.starts_at).slice(0,10),
                    ends_at: String(r.ends_at).slice(0,10),
                  })} className="text-xs text-brand-600 hover:underline">Edit</button>
                  <button onClick={() => remove(r.id)} className="text-xs text-rose-600 hover:underline">Hapus</button>
                </div>
              )},
          ]}
          rows={items}
        />

        {editing && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
            <form onSubmit={save} className="bg-white rounded-lg shadow-xl max-w-xl w-full p-5 space-y-3 my-8">
              <h2 className="font-semibold text-slate-800">
                {editing.id ? 'Edit promo' : 'Promo baru'}
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-500">
                  Code
                  <input required value={editing.code} pattern="[A-Z0-9_-]{2,32}"
                    onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono" />
                </label>
                <label className="text-xs text-slate-500">
                  Kategori (opsional)
                  <input value={editing.product_category || ''}
                    onChange={(e) => setEditing({ ...editing, product_category: e.target.value })}
                    placeholder="papan / bouquet / parsel / cake"
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </label>
              </div>
              <label className="text-xs text-slate-500 block">
                Deskripsi (yang AI sampaikan)
                <textarea required rows={2} value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-500">
                  Diskon %
                  <input type="number" min="0" max="100" value={editing.discount_pct ?? ''}
                    onChange={(e) => setEditing({ ...editing, discount_pct: e.target.value })}
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </label>
                <label className="text-xs text-slate-500">
                  Diskon nominal (Rp)
                  <input type="number" min="0" value={editing.discount_amount ?? ''}
                    onChange={(e) => setEditing({ ...editing, discount_amount: e.target.value })}
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-500">
                  Mulai
                  <input required type="date" value={editing.starts_at}
                    onChange={(e) => setEditing({ ...editing, starts_at: e.target.value })}
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </label>
                <label className="text-xs text-slate-500">
                  Berakhir
                  <input required type="date" value={editing.ends_at}
                    onChange={(e) => setEditing({ ...editing, ends_at: e.target.value })}
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
                </label>
              </div>
              <label className="text-xs text-slate-500 block">
                Kota (opsional)
                <input value={editing.city || ''}
                  onChange={(e) => setEditing({ ...editing, city: e.target.value })}
                  placeholder="Jakarta / Bekasi / kosongkan untuk semua kota"
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm" />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={!!editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Aktif
              </label>
              {error && <p className="text-sm text-rose-600">{error}</p>}
              <div className="flex gap-2 justify-end pt-2">
                <button type="button" onClick={() => setEditing(null)} className="px-3 py-2 text-sm text-slate-600">Batal</button>
                <button type="submit" className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium">
                  Simpan
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </Layout>
  );
}
