import Link from 'next/link';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import PerformanceTierPill from '@/components/PerformanceTierPill';

function Sparkline({ series }) {
  if (!Array.isArray(series) || series.length === 0) return <span className="text-slate-300">—</span>;
  const vals = series.map((v) => Number(v) || 0);
  const max = Math.max(...vals, 1);
  return (
    <span className="inline-flex items-end gap-0.5 h-5">
      {vals.map((v, i) => (
        <span key={i}
          className="w-1 bg-sky-400 rounded-sm"
          style={{ height: `${Math.max(10, (v / max) * 100)}%` }}
          title={`${Math.round(v)}`} />
      ))}
    </span>
  );
}

export default function SupervisorIndex() {
  const me = useSWR('/api/auth/me', fetcher);
  const list = useSWR('/api/supervisor/agents', fetcher, { refreshInterval: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

  if (me.data && !isAdmin) {
    return (
      <Layout title="Supervisor — Tiara">
        <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">
          Halaman ini hanya untuk admin.
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Supervisor — Tiara">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor — Agent Performance</h1>
          <span className="text-xs text-slate-500">Update tiap 60 detik</span>
        </div>

        {list.error && <div className="text-sm text-rose-600">Gagal memuat: {list.error.message}</div>}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Agent</th>
                  <th className="px-3 py-2 text-left">Tier</th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right hidden sm:table-cell">7d</th>
                  <th className="px-3 py-2 hidden sm:table-cell">Trend</th>
                  <th className="px-3 py-2 text-right hidden md:table-cell">Conv</th>
                  <th className="px-3 py-2 text-right hidden md:table-cell">Rate</th>
                  <th className="px-3 py-2 text-right">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(list.data?.items || []).map((a) => (
                  <tr key={a.staff_id} className="hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <Link href={`/supervisor/${a.staff_id}`} className="text-brand-700 hover:underline font-medium">
                        {a.full_name || a.username}
                      </Link>
                      <div className="text-xs text-slate-400">@{a.username} · {a.role}
                        {a.coaching_status && (
                          <span className="ml-1 inline-flex items-center text-[10px] px-1 rounded border border-purple-200 bg-purple-50 text-purple-700"
                            title={a.coaching_status}>🎯</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2"><PerformanceTierPill score={a.today_score} /></td>
                    <td className="px-3 py-2 text-right text-sm">
                      {a.today_score != null ? Number(a.today_score).toFixed(0) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-sm text-slate-500 hidden sm:table-cell">
                      {a.avg7d_score != null ? Number(a.avg7d_score).toFixed(0) : '—'}
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell"><Sparkline series={a.series7d} /></td>
                    <td className="px-3 py-2 text-right text-sm hidden md:table-cell">{a.conv_handled || 0}</td>
                    <td className="px-3 py-2 text-right text-sm hidden md:table-cell">
                      {a.conversion_rate != null ? `${Math.round(a.conversion_rate * 100)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {a.open_flags > 0
                        ? <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">{a.open_flags}</span>
                        : <span className="text-xs text-slate-400">0</span>}
                    </td>
                  </tr>
                ))}
                {list.data?.items?.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">Belum ada data agent</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
