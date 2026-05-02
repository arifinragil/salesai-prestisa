import useSWR from 'swr';
import { useState } from 'react';
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
  const costBreakdown = useSWR('/api/admin/cost/breakdown', fetcher, { refreshInterval: 30_000 });
  const breakdown = useSWR('/api/admin/metrics/handover-breakdown?days=7', fetcher, { refreshInterval: 60_000 });
  const recent = useSWR('/api/admin/metrics/recent', fetcher, { refreshInterval: 60_000 });
  const handovers = useSWR('/api/inbox/handovers?open=true', fetcher, { refreshInterval: 15_000 });
  const timeline = useSWR('/api/admin/timeline/24h', fetcher, { refreshInterval: 60_000 });
  const csat = useSWR('/api/inbox/csat/recent?limit=20', fetcher, { refreshInterval: 60_000 });
  const evalRuns = useSWR('/api/admin/eval/runs?limit=10', fetcher);
  const waHealth = useSWR('/api/admin/wa-health', fetcher, { refreshInterval: 60_000 });
  const heatmap = useSWR('/api/admin/heatmap/response-time?days=7', fetcher, { refreshInterval: 5 * 60_000 });
  const aiQuality = useSWR('/api/admin/ai-quality/recent?days=7', fetcher, { refreshInterval: 5 * 60_000 });
  const conversion = useSWR('/api/admin/conversion/attribution?days=30', fetcher, { refreshInterval: 5 * 60_000 });
  const opPerf = useSWR('/api/admin/operator-performance?days=30', fetcher, { refreshInterval: 5 * 60_000 });
  const cohort = useSWR('/api/admin/cohort-retention?days=90', fetcher, { refreshInterval: 60 * 60_000 });
  const pipelineSummary = useSWR('/api/pipeline/forecast?days=30', fetcher, { refreshInterval: 5 * 60_000 });

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

  const timelineRows = timeline.data?.items || [];
  const tlMax = Math.max(1, ...timelineRows.map((r) => Number(r.inbound) + Number(r.ai_out) + Number(r.staff_out)));

  const [evalBusy, setEvalBusy] = useState(false);
  async function runEval() {
    if (!confirm('Jalankan eval set? Akan memakai quota AI provider untuk testing (~10-30 detik).')) return;
    setEvalBusy(true);
    try {
      const r = await api('/api/admin/eval/run', { method: 'POST' });
      toast.success(`Eval ${r.passed}/${r.total} passed (${r.pass_rate}%)`);
      evalRuns.mutate();
    } catch (e) { toast.error(e.message); }
    finally { setEvalBusy(false); }
  }

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

        {/* Cost breakdown per provider/model */}
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Cost breakdown — provider × model</h2>
            <span className="text-xs text-slate-400">today UTC</span>
          </div>
          {(costBreakdown.data?.breakdown || []).length === 0 ? (
            <div className="text-sm text-slate-400 px-5 py-6">Belum ada AI activity hari ini.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Provider</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-right">Pesan</th>
                  <th className="px-4 py-2 text-right">Tokens in</th>
                  <th className="px-4 py-2 text-right">Tokens out</th>
                  <th className="px-4 py-2 text-right">Cost (USD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(costBreakdown.data?.breakdown || []).map((r, i) => (
                  <tr key={`${r.provider}-${r.model}-${i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2 capitalize">{r.provider}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                    <td className="px-4 py-2 text-right">{r.messages}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{r.tokens_in.toLocaleString('id-ID')}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{r.tokens_out.toLocaleString('id-ID')}</td>
                    <td className="px-4 py-2 text-right font-medium">${r.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
                {costBreakdown.data?.total && (
                  <tr className="bg-slate-50 font-semibold">
                    <td className="px-4 py-2" colSpan={2}>Total</td>
                    <td className="px-4 py-2 text-right">{costBreakdown.data.total.messages}</td>
                    <td className="px-4 py-2 text-right">{costBreakdown.data.total.tokens_in.toLocaleString('id-ID')}</td>
                    <td className="px-4 py-2 text-right">{costBreakdown.data.total.tokens_out.toLocaleString('id-ID')}</td>
                    <td className="px-4 py-2 text-right">${costBreakdown.data.total.cost_usd.toFixed(4)}</td>
                  </tr>
                )}
              </tbody>
            </table>
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

        {/* WhatsApp send health (anti-ban signals) */}
        {waHealth.data?.overall && (
          <div className={`bg-white border rounded-lg p-5 ${
            waHealth.data.overall.health === 'critical' ? 'border-rose-300' :
            waHealth.data.overall.health === 'warning'  ? 'border-amber-300' :
                                                          'border-slate-200'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-700">WhatsApp send health (24h)</h2>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                waHealth.data.overall.health === 'critical' ? 'bg-rose-100 text-rose-700' :
                waHealth.data.overall.health === 'warning'  ? 'bg-amber-100 text-amber-700' :
                                                              'bg-emerald-100 text-emerald-700'
              }`}>{waHealth.data.overall.health.toUpperCase()}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] text-slate-500 uppercase">Sent</div>
                <div className="text-lg font-semibold text-slate-800">{waHealth.data.overall.sent_24h}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase">Failed</div>
                <div className="text-lg font-semibold text-slate-800">{waHealth.data.overall.failed_24h}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase">Fail rate</div>
                <div className="text-lg font-semibold text-slate-800">{waHealth.data.overall.fail_rate_pct}%</div>
              </div>
            </div>
            {waHealth.data.suspect_blocked?.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <div className="text-[10px] uppercase text-slate-500 mb-1.5">
                  Suspect blocked ({waHealth.data.suspect_blocked.length})
                </div>
                <ul className="space-y-1 text-xs max-h-40 overflow-y-auto">
                  {waHealth.data.suspect_blocked.map((s) => (
                    <li key={s.conversation_id} className="flex items-center justify-between">
                      <Link href={`/inbox/${s.conversation_id}`} className="text-slate-700 hover:text-brand-600 truncate">
                        {s.phone}
                      </Link>
                      <span className="text-rose-600 tabular-nums">{s.failures}/{s.attempts} fail</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-[10px] text-slate-400 mt-3">
              Fail rate &gt;1% = warning, &gt;5% = critical (kemungkinan nomor mulai diflag/diblokir).
              Threshold env: <code>WA_SEND_HOURLY_CAP={'{60}'}</code>, <code>WA_SEND_DAILY_CAP={'{300}'}</code>.
            </p>
          </div>
        )}

        {/* 24h timeline (CSS-only stacked bar chart) */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Aktivitas 24 jam terakhir</h2>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-slate-400 inline-block" />Inbound</span>
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-brand-500 inline-block" />AI</span>
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-blue-500 inline-block" />Operator</span>
            </div>
          </div>
          {timelineRows.length === 0 ? (
            <div className="text-sm text-slate-400 py-8 text-center">Belum ada aktivitas hari ini.</div>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {timelineRows.map((r) => {
                const inbound = Number(r.inbound);
                const ai = Number(r.ai_out);
                const staff = Number(r.staff_out);
                const total = inbound + ai + staff;
                const h = (n) => `${(n / tlMax) * 100}%`;
                const hour = new Date(r.hour).getHours();
                return (
                  <div key={r.hour} className="flex-1 flex flex-col justify-end min-w-0 group relative" title={`${hour}:00 — in:${inbound} ai:${ai} ops:${staff}`}>
                    <div className="flex flex-col-reverse" style={{ height: total ? h(total) : '0%' }}>
                      <div className="bg-slate-400" style={{ height: total ? `${(inbound/total)*100}%` : 0 }} />
                      <div className="bg-brand-500" style={{ height: total ? `${(ai/total)*100}%` : 0 }} />
                      <div className="bg-blue-500" style={{ height: total ? `${(staff/total)*100}%` : 0 }} />
                    </div>
                    {hour % 3 === 0 && (
                      <div className="text-[10px] text-slate-400 text-center mt-1">{hour}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* CSAT + Eval */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">CSAT 30 hari</h2>
            {csat.data?.stats_30d?.total > 0 ? (
              <>
                <div className="flex items-baseline gap-3 mb-3">
                  <span className="text-3xl font-semibold text-slate-800">{csat.data.stats_30d.avg}</span>
                  <span className="text-xs text-slate-500">avg score · {csat.data.stats_30d.total} responses</span>
                </div>
                <div className="flex gap-1 text-xs">
                  <span className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                    😊 Puas (4-5): {csat.data.stats_30d.satisfied}
                  </span>
                  <span className="px-2 py-1 rounded bg-rose-50 text-rose-700 border border-rose-200">
                    😞 Tidak (1-2): {csat.data.stats_30d.unsatisfied}
                  </span>
                </div>
                <ul className="mt-3 max-h-40 overflow-y-auto divide-y divide-slate-100 text-xs">
                  {(csat.data.items || []).slice(0, 8).map((c) => (
                    <li key={c.id} className="py-1.5 flex items-center justify-between">
                      <Link href={`/inbox/${c.conversation_id}`} className="text-slate-600 hover:underline">
                        {c.phone}
                      </Link>
                      <span>{'⭐'.repeat(c.score)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="text-sm text-slate-400">Belum ada respon CSAT — kirim survey via tombol di chat detail.</div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-700">Eval runs</h2>
              <button
                onClick={runEval}
                disabled={evalBusy}
                className="text-xs px-3 py-1.5 rounded-md bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100 disabled:opacity-50"
              >
                {evalBusy ? 'Running…' : 'Run sekarang'}
              </button>
            </div>
            {(evalRuns.data?.items || []).length === 0 ? (
              <div className="text-sm text-slate-400">Belum pernah dijalankan. Klik "Run sekarang".</div>
            ) : (
              <ul className="space-y-2 text-sm">
                {(evalRuns.data.items).slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                    <span className="text-slate-600 text-xs">{formatRelative(r.ran_at)}</span>
                    <span className={`font-medium ${Number(r.pass_rate) >= 85 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {r.passed}/{r.total} ({r.pass_rate}%)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* AI quality + Conversion attribution */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Skor kualitas AI 30 hari</h2>
            {Number(aiQuality.data?.stats_30d?.n || 0) > 0 ? (
              <>
                <div className="flex items-baseline gap-3 mb-3">
                  <span className="text-3xl font-semibold text-slate-800">{aiQuality.data.stats_30d.avg_overall}</span>
                  <span className="text-xs text-slate-500">avg overall · {aiQuality.data.stats_30d.n} sample (LLM-as-judge)</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                  <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                    <div className="text-slate-500">Relevance</div>
                    <div className="font-semibold text-slate-800">{aiQuality.data.stats_30d.avg_relevance}</div>
                  </div>
                  <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                    <div className="text-slate-500">Tone</div>
                    <div className="font-semibold text-slate-800">{aiQuality.data.stats_30d.avg_tone}</div>
                  </div>
                  <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                    <div className="text-slate-500">Factual</div>
                    <div className="font-semibold text-slate-800">{aiQuality.data.stats_30d.avg_factual}</div>
                  </div>
                </div>
                <ul className="max-h-40 overflow-y-auto divide-y divide-slate-100 text-xs">
                  {(aiQuality.data.recent || []).slice(0, 6).map((r) => (
                    <li key={r.id} className="py-1.5">
                      <div className="flex items-center justify-between">
                        <Link href={`/inbox/${r.conversation_id}`} className="text-slate-600 hover:underline">
                          conv #{r.conversation_id}
                        </Link>
                        <span className={`font-medium ${Number(r.overall) >= 4 ? 'text-emerald-700' : Number(r.overall) >= 3 ? 'text-amber-700' : 'text-rose-700'}`}>
                          {Number(r.overall).toFixed(1)}
                        </span>
                      </div>
                      {r.reasoning && <div className="text-slate-500 line-clamp-1">{r.reasoning}</div>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="text-sm text-slate-400">Sampler jalan tiap Minggu 03:17 WIB. Belum ada skor.</div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Konversi link order (30 hari)</h2>
            {conversion.data?.summary ? (
              <>
                <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                  <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                    <div className="text-slate-500">Link dikirim</div>
                    <div className="font-semibold text-slate-800">{conversion.data.summary.links_sent_30d}</div>
                  </div>
                  <div className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1.5">
                    <div className="text-slate-500">Order jadi</div>
                    <div className="font-semibold text-emerald-800">{conversion.data.summary.orders_converted}</div>
                  </div>
                  <div className="rounded bg-brand-50 border border-brand-200 px-2 py-1.5">
                    <div className="text-slate-500">Conv rate</div>
                    <div className="font-semibold text-brand-800">{conversion.data.summary.conversion_rate}%</div>
                  </div>
                </div>
                <div className="text-xs text-slate-600">
                  Revenue: <span className="font-semibold">Rp {Number(conversion.data.summary.revenue_idr).toLocaleString('id-ID')}</span>
                </div>
                {conversion.data.funnel && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <div className="text-[11px] text-slate-500 mb-1.5">Funnel stages (30 hari)</div>
                    {(() => {
                      const f = conversion.data.funnel;
                      const sent = Number(conversion.data.summary.links_sent_30d) || 0;
                      const stages = [
                        { label: 'Link sent',   n: sent },
                        { label: 'Click',       n: f.click || 0 },
                        { label: 'Form load',   n: f.form_loaded || 0 },
                        { label: 'Submitted',   n: f.submitted || 0 },
                        { label: 'Paid',        n: Number(conversion.data.summary.orders_converted) || 0 },
                      ];
                      const top = Math.max(...stages.map((s) => s.n)) || 1;
                      return (
                        <ul className="space-y-1 text-xs">
                          {stages.map((s, i) => {
                            const w = Math.round((s.n / top) * 100);
                            const dropPct = i > 0 && stages[i - 1].n > 0
                              ? Math.round((1 - s.n / stages[i - 1].n) * 100)
                              : null;
                            return (
                              <li key={s.label} className="flex items-center gap-2">
                                <span className="w-20 text-slate-600 shrink-0">{s.label}</span>
                                <div className="flex-1 h-5 bg-slate-50 rounded overflow-hidden">
                                  <div className="h-full bg-brand-400" style={{ width: `${w}%` }} />
                                </div>
                                <span className="w-10 text-right font-medium text-slate-700">{s.n}</span>
                                <span className={`w-12 text-right text-[10px] ${dropPct === null ? 'text-transparent' : dropPct > 50 ? 'text-rose-600' : 'text-slate-400'}`}>
                                  {dropPct === null ? '-' : `-${dropPct}%`}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      );
                    })()}
                  </div>
                )}
                {conversion.data.note && <div className="text-xs text-amber-600 mt-2">⚠ {conversion.data.note}</div>}
              </>
            ) : (
              <div className="text-sm text-slate-400">Belum ada data konversi.</div>
            )}
          </div>
        </div>

        {/* Heatmap respon */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Heatmap waktu respon (avg detik, 14 hari)</h2>
          {(heatmap.data?.items || []).length === 0 ? (
            <div className="text-sm text-slate-400">Belum ada data.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[10px] border-separate border-spacing-0.5">
                <thead>
                  <tr>
                    <th className="text-right pr-2 text-slate-500 font-normal">hari\jam</th>
                    {Array.from({ length: 24 }, (_, h) => (
                      <th key={h} className="w-7 text-center text-slate-500 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {['Min','Sen','Sel','Rab','Kam','Jum','Sab'].map((label, dow) => (
                    <tr key={dow}>
                      <td className="text-right pr-2 text-slate-600">{label}</td>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = heatmap.data.items.find((it) => it.dow === dow && it.hour === h);
                        const sec = cell ? Number(cell.avg_seconds) : null;
                        let bg = 'bg-slate-50 text-slate-300';
                        if (sec !== null) {
                          if (sec <= 15) bg = 'bg-emerald-200 text-emerald-900';
                          else if (sec <= 60) bg = 'bg-emerald-100 text-emerald-800';
                          else if (sec <= 180) bg = 'bg-amber-100 text-amber-800';
                          else bg = 'bg-rose-200 text-rose-900';
                        }
                        return (
                          <td key={h} className={`w-7 h-6 text-center rounded ${bg}`} title={cell ? `${sec}s · n=${cell.n}` : 'no data'}>
                            {sec !== null ? (sec < 100 ? Math.round(sec) : Math.round(sec / 60) + 'm') : ''}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Operator performance + Cohort retention */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5 overflow-hidden">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Operator performance (30 hari)</h2>
            {(opPerf.data?.items || []).length === 0
              ? <div className="text-sm text-slate-400">Belum ada data.</div>
              : (
                <div className="overflow-x-auto -mx-2">
                  <table className="text-xs w-full">
                    <thead className="text-[10px] uppercase text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left">Operator</th>
                        <th className="px-2 py-1 text-right">Sent</th>
                        <th className="px-2 py-1 text-right">Avg respon</th>
                        <th className="px-2 py-1 text-right">HO solved</th>
                        <th className="px-2 py-1 text-right">CSAT</th>
                        <th className="px-2 py-1 text-right">AI corr</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {opPerf.data.items.map((op) => (
                        <tr key={op.id} className="hover:bg-slate-50">
                          <td className="px-2 py-1.5">{op.full_name || op.username}</td>
                          <td className="px-2 py-1.5 text-right font-medium text-slate-700">{op.sent_n}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">
                            {op.avg_response_sec > 0 ? `${op.avg_response_sec < 60 ? op.avg_response_sec + 's' : Math.round(op.avg_response_sec/60) + 'm'}` : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{op.handovers_resolved}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{op.avg_csat ? `${op.avg_csat} (${op.csat_n})` : '—'}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{op.ai_corrections}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Cohort retention — AI vs Operator</h2>
            {cohort.data?.cohorts ? (
              <div className="space-y-3 text-xs">
                {cohort.data.cohorts.map((c) => (
                  <div key={c.label}>
                    <div className="flex items-center justify-between text-slate-600 mb-1">
                      <span className="font-medium capitalize">{c.label}-handled ({c.total} customers)</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[30, 60, 90].map((d) => (
                        <div key={d} className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5">
                          <div className="text-slate-500">Repeat {d}d</div>
                          <div className="font-semibold text-slate-800">{c[`repeat_${d}d_pct`]}%</div>
                          <div className="text-[10px] text-slate-400">{c[`repeat_${d}d`]} cust.</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : <div className="text-sm text-slate-400">Belum ada data — perlu &gt;30 hari history.</div>}
          </div>
        </div>

        {/* Pipeline summary */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Pipeline summary 30d</h2>
            <Link href="/pipeline" className="text-xs text-brand-600 hover:underline">Buka kanban →</Link>
          </div>
          {pipelineSummary.data ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded bg-brand-50 border border-brand-200 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Expected revenue</div>
                <div className="text-lg font-semibold text-brand-800">Rp {Number(pipelineSummary.data.expected_revenue || 0).toLocaleString('id-ID')}</div>
              </div>
              <div className="rounded bg-emerald-50 border border-emerald-200 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Realized 30d</div>
                <div className="text-lg font-semibold text-emerald-800">Rp {Number(pipelineSummary.data.realized_revenue_30d || 0).toLocaleString('id-ID')}</div>
              </div>
              <div className="rounded bg-slate-50 border border-slate-200 px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Active deals</div>
                <div className="text-lg font-semibold text-slate-800">{pipelineSummary.data.deal_count || 0}</div>
              </div>
              <div className="md:col-span-3 grid grid-cols-3 sm:grid-cols-7 gap-1">
                {Object.entries(pipelineSummary.data.by_stage || {}).map(([stage, d]) => (
                  <div key={stage} className="rounded bg-slate-50 border border-slate-200 px-2 py-1.5 text-center">
                    <div className="text-[10px] text-slate-500">{stage}</div>
                    <div className="text-sm font-semibold text-slate-800">{d.count}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : <div className="text-sm text-slate-400">Loading…</div>}
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
