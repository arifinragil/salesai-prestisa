import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import SimpleTable from '@/components/SimpleTable';
import { api, fetcher } from '@/lib/api';

export default function ReplyTemplatesPage() {
  const { data, mutate } = useSWR('/api/ops/reply-templates?all=true', fetcher);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  function blank() { return { shortcut: '', title: '', body: '', category: '', enabled: true }; }
  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      if (editing.id) {
        await api(`/api/ops/reply-templates/${editing.id}`, { method: 'PUT', body: editing });
      } else {
        await api('/api/ops/reply-templates', { method: 'POST', body: editing });
      }
      setEditing(null); mutate();
    } catch (err) { setError(err.message); }
  }
  async function remove(id) {
    if (!confirm('Hapus template ini?')) return;
    try { await api(`/api/ops/reply-templates/${id}`, { method: 'DELETE' }); mutate(); } catch (err) { alert(err.message); }
  }

  const items = data?.items || [];
  return (
    <Layout title="Reply templates – Tiara CRM">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">Reply templates</h1>
          <button
            onClick={() => setEditing(blank())}
            className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium"
          >+ Template baru</button>
        </div>
        <p className="text-sm text-slate-500">
          Operator bisa pakai shortcut <code>/nama</code> di chat composer untuk insert isi template.
        </p>

        <SimpleTable
          columns={[
            { key: 'shortcut', label: 'Shortcut',
              render: (r) => <code className="text-xs bg-slate-100 rounded px-1.5 py-0.5">/{r.shortcut}</code> },
            { key: 'title', label: 'Judul' },
            { key: 'category', label: 'Kategori' },
            { key: 'body', label: 'Preview',
              render: (r) => <span className="text-slate-600 line-clamp-2 max-w-xs">{r.body}</span> },
            { key: 'enabled', label: 'Aktif',
              render: (r) => r.enabled
                ? <span className="text-emerald-600 text-xs">ON</span>
                : <span className="text-slate-400 text-xs">off</span> },
            { key: 'actions', label: '', cellClass: 'text-right whitespace-nowrap',
              render: (r) => (
                <div className="space-x-2">
                  <button onClick={() => setEditing(r)} className="text-xs text-brand-600 hover:underline">Edit</button>
                  <button onClick={() => remove(r.id)} className="text-xs text-rose-600 hover:underline">Hapus</button>
                </div>
              )},
          ]}
          rows={items}
        />

        {editing && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
            <form onSubmit={save} className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 space-y-3">
              <h2 className="font-semibold text-slate-800">
                {editing.id ? 'Edit template' : 'Template baru'}
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-500 col-span-1">
                  Shortcut
                  <input
                    required value={editing.shortcut || ''}
                    onChange={(e) => setEditing({ ...editing, shortcut: e.target.value.toLowerCase() })}
                    placeholder="cs_jam"
                    pattern="[a-z0-9_-]{2,32}"
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-xs text-slate-500 col-span-1">
                  Kategori
                  <input
                    value={editing.category || ''}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    placeholder="cs / sales / faq"
                    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="text-xs text-slate-500 block">
                Judul
                <input
                  required value={editing.title || ''}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs text-slate-500 block">
                Body
                <textarea
                  required rows={6} value={editing.body || ''}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono"
                />
              </label>
              {editing.id && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox" checked={!!editing.enabled}
                    onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                  />
                  Aktif
                </label>
              )}
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
