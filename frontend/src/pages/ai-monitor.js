import useSWR from 'swr';
import Link from 'next/link';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useToast } from '@/components/Toast';
import { formatRelative, formatRupiah } from '@/lib/format';

const REASON_LABEL = {
  complaint: 'Komplain', refund: 'Refund', cancel: 'Cancel',
  custom_price: 'Custom price', explicit_request_human: 'Minta orang',
  low_confidence: 'AI ragu', tool_error: 'Tool error',
  other: 'Lainnya', legal: 'Legal', angry: 'Marah',
};

function StatCard({ label, value, hint, className = '' }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-lg p-4 ${className}`}>
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-slate-800 mt-1">{value}</div>
      {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
    </div>
  );
}

export default function AiMonitor() {
  const toast = useToast();
  const today = useSWR('/api/admin/metrics/today', fetcher, { refreshInterval: 10_000 });
  const cost = useSWR('/api/admin/cost/today', fetcher, { refreshInterval: 10_000 });
  const breakdown = useSWR('/api/admin/metrics/handover-breakdown?days=7', fetcher, { refreshInterval: 60_000 });
  const recent = useSWR('/api/admin/metrics/recent', fetcher, { refreshInterval: 60_000 });
  const handovers = useSWR('/api/inbox/handovers?open=true', fetcher, { refreshInterval: 15_000 });

  useSocket(
    {
      'crm:handover': () => { handovers.mutate(); breakdown.mutate(); today.mutate(); },
      'crm:metrics':  () => { today.mutate(); cost.mutate(); },
    },
    { joinRooms: [{ event: 'crm:join-monitor' }] }
  );

  const m = today.data?.metrics;
  const c = cost.data;
  const handoverRate = m && m.inbound_today > 0
    ? Math.round((m.handovers_today / m.inbound_today) * 100)
    : null;
  const costPercent = c?.percent ?? 0;
  const meterColor =
    costPercent >= 100 ? 'bg-rose-500'
    : costPercent >= 80 ? 'bg-amber-500'
    : 'bg-emerald-500';

  async function resolveHandover(id) {
    try {
      await api(`/api/inbox/handovers/${id}/resolve`, { method: 'POST' });
      toast.success('Resolved');
      handovers.mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <Layout title="Monitor — Tiara">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Monitor hari ini</h1>
          <div className="text-xs text-slate-500">
            Auto-refresh tiap 10 detik · {m?.date || '—'}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Inbound" value={m?.inbound_today ?? '—'} hint="Pesan masuk hari ini" />
          <StatCard label="AI sent" value={m?.ai_sent_today ?? '—'} hint="Reply AI terkirim" />
          <StatCard
            label="Handover"
            value={m?.handovers_today ?? '—'}
            hint={handoverRate != null ? `${handoverRate}% dari inbound` : '—'}
          />
          <StatCard label="Queue depth" value={m?.queue_depth ?? '—'} hint="Pending jobs" />
        </div>

        {/* Cost meter */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-end justify-between mb-2">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wide">Cost hari ini</div>
              <div className="text-2xl font-semibold text-slate-800 mt-1">
                ${c?.current?.toFixed(4) ?? '—'}
                <span className="text-sm font-normal text-slate-400 ml-2">
                  / cap ${c?.cap?.toFixed(2) ?? '—'} ({costPercent}%)
                </span>
              </div>
            </div>
            <Link
              href="/admin/settings.html"
              className="text-xs text-slate-500 hover:text-brand-600"
              target="_blank"
            >
              Atur cap →
            </Link>
          </div>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${meterColor} transition-all`}
              style={{ width: `${Math.min(costPercent, 100)}%` }}
            />
          </div>
          {c?.overCap && (
            <div className="text-xs text-rose-600 mt-2">
              ⚠ Cap reached — AI auto-handover sampai 00:00 UTC.
            </div>
          )}
        </div>

        {/* Handover breakdown 7d + open list */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Handover 7 hari terakhir</h2>
            {breakdown.data?.breakdown?.length === 0 && (
              <div className="text-sm text-slate-400">Tidak ada handover.</div>
            )}
            <ul className="space-y-2">
              {(breakdown.data?.breakdown || []).map((b) => (
                <li key={b.reason} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{REASON_LABEL[b.reason] || b.reason}</span>
                  <span className="font-medium text-slate-800">{b.n}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">
              Open handovers ({(handovers.data?.items || []).length})
            </h2>
            {(handovers.data?.items || []).length === 0 && (
              <div className="text-sm text-slate-400">Bersih, tidak ada yang menunggu.</div>
            )}
            <ul className="space-y-2 max-h-64 overflow-y-auto">
              {(handovers.data?.items || []).slice(0, 20).map((h) => (
                <li key={h.id} className="flex items-start justify-between gap-2 text-sm border-b border-slate-100 pb-2">
                  <Link href={`/inbox/${h.conversation_id}`} className="min-w-0 flex-1 hover:bg-slate-50 -mx-2 px-2 py-1 rounded">
                    <div className="text-slate-800">
                      {h.phone}
                      <span className="status-pill status-handover ml-2">
                        {REASON_LABEL[h.reason] || h.reason}
                      </span>
                    </div>
                    {h.detail && <div className="text-xs text-slate-500 truncate">{h.detail}</div>}
                    <div className="text-xs text-slate-400">{formatRelative(h.created_at)}</div>
                  </Link>
                  <button
                    onClick={() => resolveHandover(h.id)}
                    className="text-xs px-2 py-1 rounded text-slate-500 hover:text-rose-600"
                    title="Resolve"
                  >
                    ✓
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Recent days metrics */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700">Daily rollup (30 hari terakhir)</h2>
          </div>
          {(recent.data?.items || []).length === 0 ? (
            <div className="text-sm text-slate-400 px-5 py-6">
              Belum ada rollup. Cron jalan jam 00:30 UTC tiap hari.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Tanggal</th>
                  <th className="px-4 py-2 text-right">In</th>
                  <th className="px-4 py-2 text-right">AI</th>
                  <th className="px-4 py-2 text-right">Handover</th>
                  <th className="px-4 py-2 text-right">Tokens in</th>
                  <th className="px-4 py-2 text-right">Tokens out</th>
                  <th className="px-4 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(recent.data?.items || []).map((row) => (
                  <tr key={row.date} className="hover:bg-slate-50">
                    <td className="px-4 py-2">{row.date.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-right">{row.total_inbound}</td>
                    <td className="px-4 py-2 text-right">{row.total_ai_sent}</td>
                    <td className="px-4 py-2 text-right">{row.total_handovers}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{row.total_tokens_in}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{row.total_tokens_out}</td>
                    <td className="px-4 py-2 text-right font-medium">${row.cost_usd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
