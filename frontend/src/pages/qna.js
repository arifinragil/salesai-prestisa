import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useUser } from '@/lib/useUser';
import { useRouter } from 'next/router';

const INTENT_OPTIONS = [
  '', 'greeting', 'pricing', 'product_info', 'shipping',
  'order_status', 'order_intent', 'payment', 'complaint', 'refund', 'cancel',
];

const blank = () => ({ question: '', answer: '', intent: '' });

export default function QnaPage() {
  const router = useRouter();
  const { user, isLoading } = useUser({ redirectTo: '/login' });

  const [search, setSearch] = useState('');
  const [form, setForm] = useState(null);      // null = closed, {} = new, {id,...} = edit
  const [formError, setFormError] = useState(null);
  const [embedMsg, setEmbedMsg] = useState(null);

  const swrKey = search ? `/api/qna?q=${encodeURIComponent(search)}` : '/api/qna';
  const { data, mutate } = useSWR(swrKey, fetcher);

  if (isLoading) return null;
  if (!user || user.role !== 'admin') {
    if (typeof window !== 'undefined') router.replace('/inbox');
    return null;
  }

  const items = data?.items || [];

  async function save(e) {
    e.preventDefault();
    setFormError(null);
    try {
      if (form.id) {
        await api(`/api/qna/${form.id}`, {
          method: 'PUT',
          body: { question: form.question, answer: form.answer, intent: form.intent },
        });
      } else {
        await api('/api/qna', {
          method: 'POST',
          body: { question: form.question, answer: form.answer, intent: form.intent },
        });
      }
      setForm(null);
      mutate();
    } catch (err) {
      setFormError(err.message);
    }
  }

  async function remove(id) {
    if (!confirm('Hapus Q&A ini?')) return;
    try {
      await api(`/api/qna/${id}`, { method: 'DELETE' });
      mutate();
    } catch (err) {
      alert(err.message);
    }
  }

  async function toggleEnabled(item) {
    try {
      await api(`/api/qna/${item.id}`, {
        method: 'PUT',
        body: { enabled: !item.enabled },
      });
      mutate();
    } catch (err) {
      alert(err.message);
    }
  }

  async function embedPending() {
    setEmbedMsg(null);
    try {
      const res = await api('/api/qna/embed-pending', { method: 'POST' });
      setEmbedMsg(`Berhasil embed ${res.count ?? 0} item.`);
      mutate();
    } catch (err) {
      setEmbedMsg(`Error: ${err.message}`);
    }
  }

  return (
    <Layout title="Q&A AI – Tiara CRM">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Q&amp;A AI</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={embedPending}
              className="border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-md px-3 py-2 text-sm font-medium"
            >
              ⚡ Embed pending
            </button>
            <button
              onClick={() => { setForm(blank()); setFormError(null); }}
              className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium"
            >
              + Tambah Q&amp;A
            </button>
          </div>
        </div>

        {embedMsg && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
            {embedMsg}
          </div>
        )}

        <p className="text-sm text-slate-500">
          Kelola bank pertanyaan-jawaban untuk AI vector search. Klik <b>Embed pending</b> setelah
          menambah/mengubah entri agar AI dapat menggunakannya.
        </p>

        {/* Search */}
        <div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari pertanyaan…"
            className="w-full sm:max-w-sm border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm text-slate-700">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Pertanyaan</th>
                <th className="px-4 py-3 text-left">Jawaban</th>
                <th className="px-4 py-3 text-left">Intent</th>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-center">Served</th>
                <th className="px-4 py-3 text-center">Win</th>
                <th className="px-4 py-3 text-center">Aktif</th>
                <th className="px-4 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400 text-sm">
                    {data ? 'Tidak ada data.' : 'Memuat…'}
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50 transition">
                  <td className="px-4 py-3 max-w-[200px]">
                    <span className="line-clamp-2 font-medium text-slate-800">{item.question}</span>
                  </td>
                  <td className="px-4 py-3 max-w-[260px]">
                    <span className="line-clamp-2 text-slate-600">{item.answer}</span>
                  </td>
                  <td className="px-4 py-3">
                    {item.intent
                      ? <code className="text-xs bg-sky-50 text-sky-700 rounded px-1.5 py-0.5">{item.intent}</code>
                      : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {item.source
                      ? <span className="text-xs bg-slate-100 text-slate-600 rounded px-1.5 py-0.5">{item.source}</span>
                      : <span className="text-slate-300 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-slate-500">{item.times_served ?? 0}</td>
                  <td className="px-4 py-3 text-center text-xs text-slate-500">{item.win_count ?? 0}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleEnabled(item)}
                      className={`text-xs font-medium rounded px-2 py-0.5 transition ${
                        item.enabled
                          ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                          : 'text-slate-400 bg-slate-100 hover:bg-slate-200'
                      }`}
                    >
                      {item.enabled ? 'ON' : 'off'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="space-x-2">
                      <button
                        onClick={() => { setForm({ ...item }); setFormError(null); }}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(item.id)}
                        className="text-xs text-rose-600 hover:underline"
                      >
                        Hapus
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Modal form */}
        {form && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
            <form
              onSubmit={save}
              className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 space-y-3"
            >
              <h2 className="font-semibold text-slate-800">
                {form.id ? 'Edit Q&A' : 'Q&A baru'}
              </h2>

              <label className="text-xs text-slate-500 block">
                Pertanyaan
                <textarea
                  required
                  rows={3}
                  value={form.question}
                  onChange={(e) => setForm({ ...form, question: e.target.value })}
                  placeholder="Contoh: Apakah bisa pesan untuk besok?"
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                />
              </label>

              <label className="text-xs text-slate-500 block">
                Jawaban
                <textarea
                  required
                  rows={5}
                  value={form.answer}
                  onChange={(e) => setForm({ ...form, answer: e.target.value })}
                  placeholder="Tulis jawaban lengkap di sini…"
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                />
              </label>

              <label className="text-xs text-slate-500 block">
                Intent <span className="text-slate-400">(opsional)</span>
                <select
                  value={form.intent || ''}
                  onChange={(e) => setForm({ ...form, intent: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white"
                >
                  {INTENT_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{opt || '— (none)'}</option>
                  ))}
                </select>
              </label>

              {form.id && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  Aktif
                </label>
              )}

              {formError && <p className="text-sm text-rose-600">{formError}</p>}

              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="px-3 py-2 text-sm text-slate-600"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium"
                >
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
