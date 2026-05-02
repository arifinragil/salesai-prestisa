import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import SimpleTable from '@/components/SimpleTable';
import { api, fetcher } from '@/lib/api';

export default function KnowledgePage() {
  const { data, mutate } = useSWR('/api/ops/kb-topics?all=true', fetcher);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      if (editing.id) await api(`/api/ops/kb-topics/${editing.id}`, { method: 'PUT', body: editing });
      else            await api('/api/ops/kb-topics',          { method: 'POST', body: editing });
      setEditing(null); mutate();
    } catch (err) { setError(err.message); }
  }
  async function remove(id) {
    if (!confirm('Hapus topic ini? AI tidak akan bisa kutip lagi.')) return;
    try { await api(`/api/ops/kb-topics/${id}`, { method: 'DELETE' }); mutate(); } catch (err) { alert(err.message); }
  }

  const drafts = useSWR('/api/ops/kb-drafts?status=pending', fetcher, { refreshInterval: 60_000 });

  async function approveDraft(d, topic, answer) {
    try {
      await api(`/api/ops/kb-drafts/${d.id}/approve`, { method: 'POST', body: { topic, answer } });
      drafts.mutate(); mutate();
    } catch (e) { alert(e.message); }
  }
  async function dismissDraft(id) {
    try { await api(`/api/ops/kb-drafts/${id}/dismiss`, { method: 'POST' }); drafts.mutate(); }
    catch (e) { alert(e.message); }
  }

  const items = data?.items || [];
  const pendingDrafts = drafts.data?.items || [];
  return (
    <Layout title="Knowledge base – Tiara CRM">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {pendingDrafts.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-amber-900">
              Knowledge gap kandidat ({pendingDrafts.length})
              <span className="text-xs font-normal text-amber-700"> — pertanyaan customer yang AI nggak bisa jawab</span>
            </h2>
            <ul className="space-y-2">
              {pendingDrafts.slice(0, 8).map((d) => (
                <DraftRow key={d.id} draft={d} onApprove={approveDraft} onDismiss={dismissDraft} />
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Knowledge base</h1>
            <p className="text-sm text-slate-500">
              Topic yang bisa dikutip Tiara via tool <code>get_faq(topic)</code>. Edit langsung tanpa redeploy.
            </p>
          </div>
          <button
            onClick={() => setEditing({ topic: '', body: '', enabled: true })}
            className="bg-brand-600 hover:bg-brand-700 text-white rounded-md px-4 py-2 text-sm font-medium"
          >+ Topic baru</button>
        </div>

        <SimpleTable
          columns={[
            { key: 'topic', label: 'Topic',
              render: (r) => <code className="text-xs bg-slate-100 rounded px-1.5 py-0.5">{r.topic}</code> },
            { key: 'body', label: 'Isi',
              render: (r) => <span className="text-slate-700 line-clamp-3 max-w-xl">{r.body}</span> },
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
                {editing.id ? 'Edit topic' : 'Topic baru'}
              </h2>
              <label className="text-xs text-slate-500 block">
                Topic (snake_case, mis. payment, lead_time)
                <input
                  required value={editing.topic || ''}
                  onChange={(e) => setEditing({ ...editing, topic: e.target.value.toLowerCase() })}
                  pattern="[a-z0-9_]{2,64}"
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono"
                  disabled={!!editing.id}
                />
              </label>
              <label className="text-xs text-slate-500 block">
                Isi (markdown ringan diperbolehkan)
                <textarea
                  required rows={8} value={editing.body || ''}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
                />
              </label>
              {editing.id && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={!!editing.enabled}
                    onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  Aktif (boleh dipakai oleh AI)
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

function DraftRow({ draft, onApprove, onDismiss }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState('');
  const [answer, setAnswer] = useState('');
  return (
    <li className="bg-white border border-amber-200 rounded p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-slate-800">{draft.question}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            conv #{draft.conversation_id} · {new Date(draft.created_at).toLocaleString('id-ID')}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={() => setOpen((v) => !v)} className="text-xs px-2 py-1 rounded bg-emerald-500 text-white hover:bg-emerald-600">
            {open ? 'Tutup' : 'Approve'}
          </button>
          <button onClick={() => onDismiss(draft.id)} className="text-xs px-2 py-1 rounded text-slate-500 hover:bg-slate-100">Dismiss</button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic slug (mis: lead_time, garansi)"
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={4}
            placeholder="Jawaban yang Tiara akan kutip" className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
          <button onClick={() => topic && answer && onApprove(draft, topic, answer)}
            disabled={!topic || !answer}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 text-white disabled:opacity-50">
            ✓ Buat KB topic
          </button>
        </div>
      )}
    </li>
  );
}
