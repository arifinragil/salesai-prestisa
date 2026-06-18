import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative } from '@/lib/format';

export default function UsersPage() {
  const toast = useToast();
  const list = useSWR('/api/users', fetcher);
  const me = useSWR('/api/auth/me', fetcher);
  const [draft, setDraft] = useState({ username: '', password: '', full_name: '', role: 'operator' });
  const [editing, setEditing] = useState(null); // {id, full_name, role, active}
  const [resetFor, setResetFor] = useState(null);
  const [newPw, setNewPw] = useState('');

  async function create() {
    if (!draft.username || !draft.password) return toast.error('username + password wajib');
    try {
      await api('/api/users', { method: 'POST', body: draft });
      toast.success('User dibuat');
      setDraft({ username: '', password: '', full_name: '', role: 'operator' });
      list.mutate();
    } catch (e) { toast.error(e.message); }
  }

  async function save(u) {
    try {
      await api(`/api/users/${u.id}`, {
        method: 'PUT',
        body: { full_name: u.full_name, role: u.role, active: u.active },
      });
      toast.success('Disimpan');
      setEditing(null);
      list.mutate();
    } catch (e) { toast.error(e.message); }
  }

  async function resetPassword(id) {
    if (!newPw || newPw.length < 6) return toast.error('min 6 chars');
    try {
      await api(`/api/users/${id}/reset-password`, { method: 'POST', body: { password: newPw } });
      toast.success('Password reset');
      setResetFor(null); setNewPw('');
    } catch (e) { toast.error(e.message); }
  }

  const isAdmin = me.data?.user?.role === 'admin';

  return (
    <Layout title="User management — Tiara">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">User management</h1>
          {!isAdmin && <span className="text-xs text-amber-700">read-only — admin role required to edit</span>}
        </div>

        <MyProfileBlock />


        {isAdmin && (
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Tambah user baru</h2>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              <input placeholder="Username" value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                className="px-2 py-1.5 text-sm border border-slate-200 rounded" />
              <input placeholder="Nama lengkap" value={draft.full_name}
                onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
                className="px-2 py-1.5 text-sm border border-slate-200 rounded" />
              <input placeholder="Password (min 6)" type="password" value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                className="px-2 py-1.5 text-sm border border-slate-200 rounded" />
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                className="px-2 py-1.5 text-sm border border-slate-200 rounded">
                <option value="admin">admin</option>
                <option value="operator">operator</option>
                <option value="acquisition">acquisition</option>
                <option value="acquisition_manager">acquisition manager</option>
                <option value="retention">retention</option>
                <option value="viewer">viewer</option>
              </select>
              <button onClick={create}
                className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600">+ Tambah</button>
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Role</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Online</th>
                <th className="px-3 py-2 text-left">Last login</th>
                {isAdmin && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(list.data?.items || []).map((u) => {
                const online = u.last_seen_at && (Date.now() - new Date(u.last_seen_at).getTime() < 90_000);
                const isEditing = editing?.id === u.id;
                return (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{u.username}</div>
                      {isEditing
                        ? <input value={editing.full_name || ''} onChange={(e) => setEditing({ ...editing, full_name: e.target.value })}
                            className="text-xs px-1 py-0.5 border border-slate-200 rounded mt-1 w-full" />
                        : <div className="text-xs text-slate-500">{u.full_name}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing
                        ? <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                            className="text-xs px-1 py-0.5 border border-slate-200 rounded">
                            <option value="admin">admin</option><option value="operator">operator</option><option value="acquisition">acquisition</option><option value="acquisition_manager">acquisition manager</option><option value="retention">retention</option><option value="viewer">viewer</option>
                          </select>
                        : <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">{u.role}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {isEditing
                        ? <label className="text-xs"><input type="checkbox" checked={!!editing.active}
                            onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> active</label>
                        : (u.active
                          ? <span className="text-xs text-emerald-700">aktif</span>
                          : <span className="text-xs text-rose-600">nonaktif</span>)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {online
                        ? <span className="inline-flex items-center gap-1 text-emerald-700"><span className="w-2 h-2 rounded-full bg-emerald-500"></span>online</span>
                        : <span className="text-slate-400">{u.last_seen_at ? formatRelative(u.last_seen_at) : '—'}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">{u.last_login_at ? formatRelative(u.last_login_at) : '—'}</td>
                    {isAdmin && (
                      <td className="px-3 py-2 text-right">
                        {isEditing ? (
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => save(editing)} className="text-xs px-2 py-1 rounded bg-brand-500 text-white">Save</button>
                            <button onClick={() => setEditing(null)} className="text-xs px-2 py-1 rounded text-slate-500">Cancel</button>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => setEditing({ ...u })} className="text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100">Edit</button>
                            <button onClick={() => setResetFor(u.id)} className="text-xs px-2 py-1 rounded text-amber-700 hover:bg-amber-50">Reset PW</button>
                          </div>
                        )}
                        {resetFor === u.id && (
                          <div className="mt-2 flex gap-1 justify-end">
                            <input type="password" placeholder="new password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                              className="text-xs px-1.5 py-0.5 border border-slate-200 rounded" />
                            <button onClick={() => resetPassword(u.id)} className="text-xs px-2 py-1 rounded bg-amber-500 text-white">Set</button>
                            <button onClick={() => { setResetFor(null); setNewPw(''); }} className="text-xs px-2 py-1 rounded text-slate-400">×</button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

function MyProfileBlock() {
  const me = useSWR('/api/users/me', fetcher);
  const toast = useToast();
  const [chatId, setChatId] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [testing, setTesting] = useState(false);

  if (me.data?.user && !hydrated) {
    setChatId(me.data.user.telegram_chat_id || '');
    setHydrated(true);
  }

  async function save() {
    try {
      await api('/api/users/me/telegram', { method: 'PUT', body: { telegram_chat_id: chatId.trim() } });
      toast.success('Tersimpan');
      me.mutate();
    } catch (e) { toast.error(e.message); }
  }
  async function test() {
    setTesting(true);
    try {
      await api('/api/users/me/telegram-test', { method: 'POST' });
      toast.success('Telegram test sent — cek HP kamu');
    } catch (e) { toast.error('Gagal: ' + e.message); }
    finally { setTesting(false); }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-1">Profil saya</h2>
      <p className="text-xs text-slate-500 mb-3">
        Atur chat ID Telegram pribadi untuk terima notif task & mention langsung di HP.
        Cara dapat chat ID: chat <code className="bg-slate-100 px-1 rounded">@userinfobot</code> di Telegram → bot reply ID.
      </p>
      <div className="flex gap-2">
        <input value={chatId} onChange={(e) => setChatId(e.target.value)}
          placeholder="Telegram chat ID (mis. 987654321)"
          className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
        <button onClick={save} className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600">
          Simpan
        </button>
        <button onClick={test} disabled={testing || !chatId.trim()}
          className="text-sm px-3 py-1.5 rounded border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50">
          {testing ? '…' : '✈️ Test'}
        </button>
      </div>
    </div>
  );
}
