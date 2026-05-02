import { useRouter } from 'next/router';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import PerformanceTierPill from '@/components/PerformanceTierPill';
import RedFlagBadge from '@/components/RedFlagBadge';
import { formatRelative } from '@/lib/format';

export default function SupervisorAgent() {
  const toast = useToast();
  const router = useRouter();
  const { staffId } = router.query;
  const me = useSWR('/api/auth/me', fetcher);
  const data = useSWR(staffId ? `/api/supervisor/agents/${staffId}` : null, fetcher, { refreshInterval: 60_000 });
  const [filter, setFilter] = useState('open');
  const [resolveId, setResolveId] = useState(null);
  const [note, setNote] = useState('');

  if (me.data && me.data.user?.role !== 'admin') {
    return <Layout title="Supervisor"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  const staff = data.data?.staff;
  const scores = data.data?.scores || [];
  const flags = data.data?.flags || [];
  const sug = data.data?.suggestion_stats || [];
  const todayDateStr = new Date().toISOString().slice(0, 10);
  const todayScore = scores.find((s) => String(s.date).slice(0, 10) === todayDateStr)?.performance_score;
  const filteredFlags = filter === 'open' ? flags.filter((f) => !f.resolved_at) : flags;

  async function resolve(id) {
    try {
      await api(`/api/supervisor/flags/${id}/resolve`, { method: 'POST', body: { note } });
      toast.success('Flag resolved');
      setResolveId(null); setNote('');
      data.mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <Layout title={staff ? `${staff.full_name || staff.username} — Supervisor` : 'Supervisor'}>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/supervisor" className="text-sm text-slate-500 hover:underline">← All agents</Link>
        </div>

        {staff && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-slate-800">{staff.full_name || staff.username}</h1>
              <div className="text-xs text-slate-500 mt-1">@{staff.username} · {staff.role}
                {staff.last_login_at && <> · last login {formatRelative(staff.last_login_at)}</>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <PerformanceTierPill score={todayScore} showScore />
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Score history (last {scores.length} days)</h2>
          {scores.length === 0
            ? <div className="text-sm text-slate-400">Belum ada data score</div>
            : <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
                <thead className="text-slate-500 uppercase">
                  <tr>
                    <th className="text-left py-1">Date</th>
                    <th className="text-right py-1">Score</th>
                    <th className="text-right py-1">Conv</th>
                    <th className="text-right py-1">Won/Lost</th>
                    <th className="text-right py-1">Avg Resp (s)</th>
                    <th className="text-right py-1">Sug Used %</th>
                    <th className="text-right py-1">Flags H/C</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scores.slice(0, 30).map((s) => {
                    const sugUsedPct = s.suggestion_shown > 0
                      ? Math.round(((s.suggestion_used_raw + s.suggestion_used_edited) / s.suggestion_shown) * 100)
                      : null;
                    return (
                      <tr key={s.date} className="hover:bg-slate-50">
                        <td className="py-1">{String(s.date).slice(0, 10)}</td>
                        <td className="text-right py-1 font-medium">{s.performance_score != null ? Number(s.performance_score).toFixed(0) : '—'}</td>
                        <td className="text-right py-1">{s.conv_handled}</td>
                        <td className="text-right py-1">{s.conv_closed_won}/{s.conv_closed_lost}</td>
                        <td className="text-right py-1">{s.avg_response_time_sec || '—'}</td>
                        <td className="text-right py-1">{sugUsedPct != null ? sugUsedPct + '%' : '—'}</td>
                        <td className="text-right py-1">{s.red_flags_high}/{s.red_flags_critical}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Red flags ({filteredFlags.length})</h2>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}
              className="text-xs px-2 py-1 border border-slate-200 rounded">
              <option value="open">Open only</option>
              <option value="all">All</option>
            </select>
          </div>
          {filteredFlags.length === 0
            ? <div className="text-sm text-slate-400">No flags</div>
            : <ul className="divide-y divide-slate-100">
                {filteredFlags.map((f) => (
                  <li key={f.id} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <RedFlagBadge severity={f.severity} size="xs" />
                          <span className="font-medium text-slate-800">{f.rule_id}</span>
                          {f.conversation_id && (
                            <Link href={`/inbox/${f.conversation_id}`}
                              className="text-xs text-brand-600 hover:underline">→ conv #{f.conversation_id}</Link>
                          )}
                          <span className="text-xs text-slate-400">· {formatRelative(f.detected_at)}</span>
                        </div>
                        {f.detail && Object.keys(f.detail).length > 0 && (
                          <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">
                            {JSON.stringify(f.detail)}
                          </div>
                        )}
                        {f.resolved_at && (
                          <div className="text-xs text-emerald-600 mt-0.5">
                            ✓ Resolved {formatRelative(f.resolved_at)}
                            {f.resolution_note && <span className="text-slate-500"> — {f.resolution_note}</span>}
                          </div>
                        )}
                      </div>
                      {!f.resolved_at && (
                        <button onClick={() => setResolveId(f.id)}
                          className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                          Resolve
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>}
        </div>

        {sug.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Suggestion usage</h2>
            <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead className="text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-1">Day</th>
                  <th className="text-right py-1">Shown</th>
                  <th className="text-right py-1">Raw</th>
                  <th className="text-right py-1">Edited</th>
                  <th className="text-right py-1">Manual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sug.map((s) => (
                  <tr key={s.day}>
                    <td className="py-1">{String(s.day).slice(0, 10)}</td>
                    <td className="text-right py-1">{s.shown}</td>
                    <td className="text-right py-1">{s.used_raw}</td>
                    <td className="text-right py-1">{s.used_edited}</td>
                    <td className="text-right py-1">{s.manual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>

      {resolveId && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={() => setResolveId(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 m-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Resolve red flag</h3>
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Catatan resolusi (opsional)…"
              rows={3}
              className="w-full text-sm border border-slate-200 rounded p-2 mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setResolveId(null); setNote(''); }}
                className="text-sm px-3 py-1.5 rounded border border-slate-200">Cancel</button>
              <button onClick={() => resolve(resolveId)}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600">
                Mark resolved
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
