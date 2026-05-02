import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import SimpleTable from '@/components/SimpleTable';
import { api, fetcher } from '@/lib/api';

const PALETTE = ['slate','rose','amber','emerald','sky','indigo','violet','pink'];

const TAG_COLOR = {
  slate:    'bg-slate-100 text-slate-700 border-slate-200',
  rose:     'bg-rose-100 text-rose-700 border-rose-200',
  amber:    'bg-amber-100 text-amber-800 border-amber-200',
  emerald:  'bg-emerald-100 text-emerald-700 border-emerald-200',
  sky:      'bg-sky-100 text-sky-700 border-sky-200',
  indigo:   'bg-indigo-100 text-indigo-700 border-indigo-200',
  violet:   'bg-violet-100 text-violet-700 border-violet-200',
  pink:     'bg-pink-100 text-pink-700 border-pink-200',
};

export default function TagsPage() {
  const { data, mutate } = useSWR('/api/ops/tags', fetcher);
  const [draft, setDraft] = useState({ name: '', color: 'slate', description: '' });
  const [error, setError] = useState(null);

  async function add(e) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/ops/tags', { method: 'POST', body: draft });
      setDraft({ name: '', color: 'slate', description: '' });
      mutate();
    } catch (err) { setError(err.message); }
  }
  async function remove(id) {
    if (!confirm('Hapus tag ini?')) return;
    try { await api(`/api/ops/tags/${id}`, { method: 'DELETE' }); mutate(); } catch (err) { alert(err.message); }
  }

  const items = data?.items || [];
  return (
    <Layout title="Tags – Tiara CRM">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <h1 className="text-xl font-semibold text-slate-900">Conversation tags</h1>

        <form onSubmit={add} className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              required value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Nama tag (mis. Komplain, VIP)"
              className="border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
            <select
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="border border-slate-300 rounded-md px-3 py-2 text-sm"
            >
              {PALETTE.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="submit" className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium">
              + Tambah tag
            </button>
          </div>
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Deskripsi singkat (opsional)"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </form>

        <SimpleTable
          columns={[
            { key: 'name', label: 'Nama', render: (r) => (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs ${TAG_COLOR[r.color] || TAG_COLOR.slate}`}>
                {r.name}
              </span>
            )},
            { key: 'description', label: 'Deskripsi', render: (r) => r.description || <span className="text-slate-300">—</span> },
            { key: 'conv_count', label: 'Conv', cellClass: 'text-right tabular-nums' },
            { key: 'actions', label: '', cellClass: 'text-right',
              render: (r) => (
                <button
                  onClick={() => remove(r.id)}
                  className="text-xs text-rose-600 hover:underline"
                >Hapus</button>
              )},
          ]}
          rows={items}
        />
      </div>
    </Layout>
  );
}
