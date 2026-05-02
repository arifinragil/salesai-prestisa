import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function SnippetsPage() {
  const list = useSWR('/api/users/me/snippets', fetcher);
  const toast = useToast();
  const [draft, setDraft] = useState({ shortcut: '', title: '', body: '' });

  async function save() {
    if (!draft.shortcut || !draft.body) return toast.error('shortcut + body wajib');
    try {
      await api('/api/users/me/snippets', { method: 'POST', body: draft });
      toast.success('Disimpan');
      setDraft({ shortcut: '', title: '', body: '' });
      list.mutate();
    } catch (e) { toast.error(e.message); }
  }
  async function del(id) {
    if (!confirm('Hapus snippet ini?')) return;
    await api(`/api/users/me/snippets/${id}`, { method: 'DELETE' });
    list.mutate();
  }

  return (
    <Layout title="My snippets — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Snippet pribadi</h1>
          <p className="text-sm text-slate-500">Jawaban template khusus akun ini. Ketik <code>/shortcut</code> di chat composer untuk insert.</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Tambah / update snippet</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input placeholder="shortcut (mis: salam)" value={draft.shortcut}
              onChange={(e) => setDraft({ ...draft, shortcut: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
              className="px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
            <input placeholder="judul (opsional)" value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              className="px-2 py-1.5 text-sm border border-slate-200 rounded" />
            <button onClick={save} className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600">+ Simpan</button>
          </div>
          <textarea placeholder="isi snippet…" value={draft.body} rows={3}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            className="mt-2 w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr><th className="px-3 py-2 text-left">/shortcut</th><th className="px-3 py-2 text-left">Judul</th><th className="px-3 py-2 text-left">Isi</th><th></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(list.data?.items || []).map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2"><code className="text-xs bg-slate-100 px-1 rounded">/{s.shortcut}</code></td>
                  <td className="px-3 py-2 text-slate-700">{s.title || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 max-w-xl line-clamp-2">{s.body}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => del(s.id)} className="text-xs text-rose-600 hover:underline">Hapus</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
