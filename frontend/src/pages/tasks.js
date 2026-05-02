import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative } from '@/lib/format';

const PRIORITY_ICON = { high: '🔴', normal: '', low: '⚪' };

function classifyDue(t) {
  if (!t.due_at) return 'no_due';
  const ageDays = (new Date(t.due_at).getTime() - Date.now()) / 86400000;
  if (ageDays < -1 && ['open','in_progress'].includes(t.status)) return 'overdue';
  if (ageDays < 1) return 'today';
  if (ageDays < 2) return 'tomorrow';
  return 'later';
}

const GROUPS = [
  { id: 'overdue', label: '🚨 Overdue', cls: 'border-rose-200 bg-rose-50' },
  { id: 'today', label: 'Hari ini', cls: 'border-amber-200 bg-amber-50' },
  { id: 'tomorrow', label: 'Besok', cls: 'border-blue-200 bg-blue-50' },
  { id: 'later', label: 'Nanti', cls: 'border-slate-200 bg-white' },
  { id: 'no_due', label: 'Tanpa due date', cls: 'border-slate-200 bg-white' },
];

export default function TasksPage() {
  const toast = useToast();
  const router = useRouter();
  const [ownerFilter, setOwnerFilter] = useState('me');  // me | all
  const [statusFilter, setStatusFilter] = useState('active'); // active | all | done | cancelled
  const [showComposer, setShowComposer] = useState(false);

  const url = `/api/tasks${
    ownerFilter === 'all' ? '?owner_id=0' : ''
  }${statusFilter === 'active' ? (ownerFilter === 'all' ? '&' : '?') + 'status=open,in_progress'
    : statusFilter === 'done' ? (ownerFilter === 'all' ? '&' : '?') + 'status=done'
    : statusFilter === 'cancelled' ? (ownerFilter === 'all' ? '&' : '?') + 'status=cancelled'
    : ''}`;
  // Note: owner_id=0 is hack — backend defaults to current user. For "all" we'd need a /tasks/all endpoint.
  // For v1 keep simple: only "me" shows current user's tasks.

  const { data, mutate } = useSWR(url, fetcher, { refreshInterval: 30_000 });
  const items = data?.items || [];
  const grouped = GROUPS.map((g) => ({
    ...g,
    items: items.filter((t) => classifyDue(t) === g.id),
  }));

  async function setStatus(id, status) {
    try {
      await api(`/api/tasks/${id}/status`, { method: 'POST', body: { status } });
      mutate();
    } catch (e) { toast.error(e.message); }
  }
  async function snooze(id, hours) {
    try {
      await api(`/api/tasks/${id}/snooze`, { method: 'POST', body: { hours } });
      toast.success(`Snooze ${hours}j`);
      mutate();
    } catch (e) { toast.error(e.message); }
  }
  async function del(id) {
    if (!confirm('Hapus task ini?')) return;
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    mutate();
  }

  return (
    <Layout title="Tasks — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-slate-800">Tasks</h1>
          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            <option value="me">Owner: Me</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            <option value="active">Active (open + in_progress)</option>
            <option value="all">All status</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button onClick={() => setShowComposer(true)}
            className="ml-auto text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600">
            + New task
          </button>
        </div>

        {grouped.map((g) => g.items.length === 0 ? null : (
          <section key={g.id}>
            <div className={`text-xs font-semibold mb-2 px-2 py-1 inline-block rounded border ${g.cls}`}>
              {g.label} ({g.items.length})
            </div>
            <ul className="space-y-2">
              {g.items.map((t) => (
                <li key={t.id} className="bg-white border border-slate-200 rounded-md p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800">
                        {PRIORITY_ICON[t.priority]} {t.title}
                      </div>
                      {t.body && <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">{t.body}</div>}
                      <div className="text-[11px] text-slate-400 mt-1 flex flex-wrap items-center gap-2">
                        {t.due_at && <span>Due {formatRelative(t.due_at)}</span>}
                        {t.conversation_id && (
                          <a onClick={(e) => { e.preventDefault(); router.push(`/inbox/${t.conversation_id}`); }}
                            href="#" className="text-brand-600 hover:underline">
                            conv #{t.conversation_id}
                          </a>
                        )}
                        <span className={`px-1.5 py-0.5 rounded ${
                          t.status === 'in_progress' ? 'bg-blue-100 text-blue-700' :
                          t.status === 'done' ? 'bg-emerald-100 text-emerald-700' :
                          t.status === 'cancelled' ? 'bg-slate-100 text-slate-500' :
                          'bg-amber-100 text-amber-700'
                        }`}>{t.status}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {t.status === 'open' && (
                        <button onClick={() => setStatus(t.id, 'in_progress')}
                          className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100">
                          ▶ Start
                        </button>
                      )}
                      {['open','in_progress'].includes(t.status) && (
                        <>
                          <button onClick={() => setStatus(t.id, 'done')}
                            className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                            ✓ Done
                          </button>
                          <button onClick={() => snooze(t.id, 4)}
                            className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-50" title="Snooze 4j">
                            💤
                          </button>
                          <button onClick={() => setStatus(t.id, 'cancelled')}
                            className="text-xs px-2 py-1 rounded text-rose-500 hover:bg-rose-50" title="Cancel">
                            ✗
                          </button>
                        </>
                      )}
                      {t.status === 'done' && (
                        <button onClick={() => setStatus(t.id, 'open')}
                          className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-50">
                          Re-open
                        </button>
                      )}
                      <button onClick={() => del(t.id)}
                        className="text-xs px-2 py-1 rounded text-slate-400 hover:bg-slate-50" title="Hapus">
                        🗑
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {items.length === 0 && (
          <div className="text-center text-sm text-slate-400 py-12">
            Tidak ada task. Klik <b>+ New task</b> untuk mulai.
          </div>
        )}
      </div>

      {showComposer && (
        <TaskComposerModal onClose={() => setShowComposer(false)} onCreated={() => { mutate(); setShowComposer(false); }} />
      )}
    </Layout>
  );
}

function TaskComposerModal({ onClose, onCreated, defaults = {} }) {
  const toast = useToast();
  const users = useSWR('/api/users/active', fetcher);
  const me = useSWR('/api/users/me', fetcher);
  const [draft, setDraft] = useState({
    title: defaults.title || '',
    body: defaults.body || '',
    owner_id: defaults.owner_id || '',
    due_at: defaults.due_at || tomorrow17(),
    priority: defaults.priority || 'normal',
    conversation_id: defaults.conversation_id || '',
  });

  function tomorrow17() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(17, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  }

  async function submit() {
    if (!draft.title.trim()) return toast.error('Title wajib');
    try {
      await api('/api/tasks', { method: 'POST', body: {
        title: draft.title,
        body: draft.body || null,
        owner_id: draft.owner_id ? parseInt(draft.owner_id) : (me.data?.user?.id),
        conversation_id: draft.conversation_id ? parseInt(draft.conversation_id) : null,
        due_at: draft.due_at,
        priority: draft.priority,
      }});
      toast.success('Task dibuat');
      onCreated();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-semibold text-slate-800">Task baru</h3>
        <input
          value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="Title (wajib)"
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded"
          autoFocus
        />
        <textarea
          value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          placeholder="Detail (opsional)" rows={3}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded"
        />
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-slate-500 space-y-1">
            <div>Owner</div>
            <select value={draft.owner_id} onChange={(e) => setDraft({ ...draft, owner_id: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded">
              <option value="">Saya</option>
              {(users.data?.items || []).filter(u => u.id !== me.data?.user?.id).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-500 space-y-1">
            <div>Priority</div>
            <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High 🔴</option>
            </select>
          </label>
        </div>
        <label className="text-xs text-slate-500 space-y-1 block">
          <div>Due datetime</div>
          <input type="datetime-local" value={draft.due_at}
            onChange={(e) => setDraft({ ...draft, due_at: e.target.value })}
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
        </label>
        <label className="text-xs text-slate-500 space-y-1 block">
          <div>Link conversation (opsional)</div>
          <input value={draft.conversation_id} onChange={(e) => setDraft({ ...draft, conversation_id: e.target.value })}
            placeholder="conv ID, mis. 224"
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
        </label>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="text-sm px-3 py-1.5 text-slate-600">Batal</button>
          <button onClick={submit} className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white">+ Save</button>
        </div>
      </div>
    </div>
  );
}
