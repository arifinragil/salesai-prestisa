import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative, formatPhone } from '@/lib/format';

const ROLE_BADGE = {
  acquisition: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  retention:   'bg-sky-100 text-sky-700 border-sky-200',
  operator:    'bg-slate-100 text-slate-700 border-slate-200',
  admin:       'bg-purple-100 text-purple-700 border-purple-200',
  staff:       'bg-slate-100 text-slate-600 border-slate-200',
};

export default function LeadDistributionPage() {
  const toast = useToast();
  const me = useSWR('/api/auth/me', fetcher);
  const cfg = useSWR('/api/lead-dist/config', fetcher, { refreshInterval: 30_000 });
  const stats = useSWR('/api/lead-dist/stats', fetcher, { refreshInterval: 30_000 });
  const unassigned = useSWR('/api/lead-dist/unassigned', fetcher, { refreshInterval: 15_000 });
  const [picking, setPicking] = useState(null); // { convId, staffId }

  const isAdmin = me.data?.user?.role === 'admin';
  if (me.data && !isAdmin) {
    return <Layout title="Lead Distribution"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  const mode = cfg.data?.mode || 'auto';
  const staffList = cfg.data?.staff || [];
  const counts = stats.data?.counts || [];
  const recent = stats.data?.recent || [];
  const unas = unassigned.data?.items || [];

  // Group counts by role
  const byRole = {};
  for (const c of counts) {
    if (!byRole[c.role || 'unknown']) byRole[c.role || 'unknown'] = { auto: 0, manual: 0, reassign: 0, total: 0 };
    byRole[c.role || 'unknown'][c.source] = c.n;
    byRole[c.role || 'unknown'].total += c.n;
  }

  async function setMode(newMode) {
    if (newMode === mode) return;
    if (newMode === 'manual' && !confirm('Mode manual: chat baru TIDAK auto-assign. Admin wajib assign manual. Lanjut?')) return;
    try {
      await api('/api/lead-dist/config', { method: 'PUT', body: { mode: newMode } });
      toast.success(`Mode: ${newMode}`);
      cfg.mutate();
    } catch (e) { toast.error(e.message); }
  }

  async function assign(convId, staffId) {
    try {
      await api('/api/lead-dist/assign', { method: 'POST', body: { conversation_id: convId, staff_id: staffId } });
      toast.success('Assigned');
      unassigned.mutate(); stats.mutate(); cfg.mutate();
      setPicking(null);
    } catch (e) { toast.error(e.message); }
  }

  return (
    <Layout title="Lead Distribution — Tiara">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Lead Distribution</h1>
          <span className="text-xs text-slate-500">Update tiap 30 detik</span>
        </div>

        {/* Mode toggle */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Distribution mode</h2>
          <div className="flex gap-2">
            <button onClick={() => setMode('auto')}
              className={`text-sm px-3 py-1.5 rounded border ${mode === 'auto' ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>
              Auto
            </button>
            <button onClick={() => setMode('manual')}
              className={`text-sm px-3 py-1.5 rounded border ${mode === 'manual' ? 'bg-brand-500 text-white border-brand-500' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>
              Manual
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            <b>Auto:</b> Chat baru otomatis assign — existing customer (DB) → retention; new customer → acquisition. Pakai least-busy algorithm.
            <br />
            <b>Manual:</b> Tidak auto-assign. Admin wajib distribute via tombol di list bawah.
          </p>
        </div>

        {/* Today distribution counts */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {['acquisition', 'retention'].map((role) => (
            <div key={role} className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold text-slate-700 capitalize">{role}</h3>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[role]}`}>{role}</span>
              </div>
              <div className="text-2xl font-semibold text-slate-800">{byRole[role]?.total || 0}</div>
              <div className="text-xs text-slate-500">
                hari ini · auto {byRole[role]?.auto || 0} / manual {byRole[role]?.manual || 0}
              </div>
            </div>
          ))}
        </div>

        {/* Staff load per role */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Active staff by role</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-1">Username</th>
                  <th className="text-left py-1">Role</th>
                  <th className="text-right py-1">Open convs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {staffList.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="py-1.5">
                      <span className="font-medium text-slate-800">{s.full_name || s.username}</span>
                      <span className="text-xs text-slate-400 ml-2">@{s.username}</span>
                    </td>
                    <td className="py-1.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[s.role] || ROLE_BADGE.staff}`}>{s.role}</span>
                    </td>
                    <td className="py-1.5 text-right font-medium text-slate-700">{s.open_convs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Unassigned conversations */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Unassigned conversations ({unas.length})</h2>
            {mode === 'auto' && unas.length > 0 && (
              <span className="text-xs text-amber-600">⚠ Auto mode tapi ada conv unassigned — kemungkinan no eligible staff</span>
            )}
          </div>
          {unas.length === 0
            ? <div className="text-sm text-slate-400">All convs assigned ✓</div>
            : <ul className="divide-y divide-slate-100">
                {unas.map((c) => {
                  const isPicking = picking?.convId === c.id;
                  return (
                    <li key={c.id} className="py-2 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="text-slate-800">{c.push_name || formatPhone(c.real_phone || c.phone)}</div>
                        <div className="text-xs text-slate-500">
                          conv #{c.id} · {formatRelative(c.last_message_at)}
                          {c.customer_id ? <span className="text-sky-600 ml-1">· existing</span> : <span className="text-emerald-600 ml-1">· new</span>}
                          {c.lead_temperature && c.lead_temperature !== 'cold' && (
                            <span className="ml-1">· {c.lead_temperature === 'hot' ? '🔥' : '🌤️'}</span>
                          )}
                        </div>
                      </div>
                      {isPicking ? (
                        <div className="flex gap-1">
                          <select onChange={(e) => e.target.value && assign(c.id, parseInt(e.target.value))}
                            className="text-xs px-2 py-1 border border-slate-200 rounded">
                            <option value="">— pick staff —</option>
                            {staffList.filter((s) => s.role === 'acquisition' || s.role === 'retention').map((s) => (
                              <option key={s.id} value={s.id}>{s.username} ({s.role}, {s.open_convs})</option>
                            ))}
                          </select>
                          <button onClick={() => setPicking(null)} className="text-xs text-slate-500 px-2">×</button>
                        </div>
                      ) : (
                        <button onClick={() => setPicking({ convId: c.id })}
                          className="text-xs px-2 py-1 rounded bg-brand-500 text-white hover:bg-brand-600">
                          Assign
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>}
        </div>

        {/* Recent assignments */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Recent assignments</h2>
          {recent.length === 0
            ? <div className="text-sm text-slate-400">Belum ada</div>
            : <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[520px]">
                  <thead className="text-slate-500 uppercase">
                    <tr>
                      <th className="text-left py-1">When</th>
                      <th className="text-left py-1">Conv</th>
                      <th className="text-left py-1">Customer</th>
                      <th className="text-left py-1">Staff</th>
                      <th className="text-left py-1">Role</th>
                      <th className="text-left py-1">Source</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {recent.map((r) => (
                      <tr key={r.id}>
                        <td className="py-1">{formatRelative(r.assigned_at)}</td>
                        <td className="py-1">#{r.conversation_id}</td>
                        <td className="py-1">{r.customer_state === 'existing'
                          ? <span className="text-sky-600">existing</span>
                          : r.customer_state === 'new' ? <span className="text-emerald-600">new</span> : '—'}</td>
                        <td className="py-1">{r.username || <span className="text-slate-400">none</span>}</td>
                        <td className="py-1">
                          {r.role && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[r.role] || ROLE_BADGE.staff}`}>{r.role}</span>}
                        </td>
                        <td className="py-1 text-slate-500">{r.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
        </div>
      </div>
    </Layout>
  );
}
