import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function offsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS = [
  { label: 'Hari ini', value: () => todayStr() },
  { label: 'Kemarin', value: () => offsetDate(1) },
  { label: '3 Hari Lalu', value: () => offsetDate(3) },
  { label: '7 Hari Lalu', value: () => offsetDate(7) },
];

const CAT_COLORS = {
  A: { bar: 'bg-rose-500', text: 'text-rose-700', bg: 'bg-rose-50' },
  B: { bar: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50' },
  C: { bar: 'bg-sky-500', text: 'text-sky-700', bg: 'bg-sky-50' },
  D: { bar: 'bg-slate-400', text: 'text-slate-600', bg: 'bg-slate-50' },
};

function CategoryBar({ cat, value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const c = CAT_COLORS[cat] || CAT_COLORS.D;
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs font-semibold w-5 ${c.text}`}>{cat}</span>
      <div className="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${c.bar} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-slate-600 w-6 text-right">{value}</span>
    </div>
  );
}

function BubbleStat({ label, value, color = 'text-slate-800', bg = 'bg-slate-50' }) {
  return (
    <div className={`flex flex-col items-center px-3 py-3 rounded-lg border border-slate-100 ${bg}`}>
      <span className={`text-xl font-bold ${color}`}>{value ?? '—'}</span>
      <span className="text-[11px] text-slate-500 mt-0.5 text-center">{label}</span>
    </div>
  );
}

export default function DailyRecapCard() {
  const [open, setOpen] = useState(true);
  const [date, setDate] = useState(todayStr);

  const { data, error } = useSWR(
    `/api/supervisor-control/daily-recap?date=${date}`,
    fetcher
  );

  const issueBreakdown = data?.issueBreakdown || {};
  const byCategory = issueBreakdown.byCategory || {};
  const matchRate = data?.matchRate || {};
  const bySupervisor = data?.bySupervisor || [];
  const bubbleProgress = data?.bubbleProgress?.summary || {};

  const catMax = Math.max(1, ...[byCategory.A, byCategory.B, byCategory.C, byCategory.D].map((v) => v || 0));

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 sm:px-5 py-4 flex items-start sm:items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base">📊</span>
            <h2 className="text-sm font-semibold text-slate-800">
              Daily Recap — Issue &amp; Action Pattern
            </h2>
          </div>
          {data && (
            <p className="text-xs text-slate-500 mt-0.5 pl-6">
              {date} ·{' '}
              {issueBreakdown.total ?? 0} issue ·{' '}
              {matchRate.match_pct ?? 0}% match AI
            </p>
          )}
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {/* Date controls */}
          <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-2">
            {DATE_PRESETS.map((p) => {
              const pVal = p.value();
              return (
                <button
                  key={p.label}
                  onClick={() => setDate(pVal)}
                  className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                    date === pVal
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'border-slate-200 text-slate-600'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="text-xs border border-slate-200 rounded-md px-3 py-1.5 text-slate-700"
            />
            {error && <span className="text-xs text-rose-500 ml-1">Gagal memuat.</span>}
            {!data && !error && <span className="text-xs text-slate-400 ml-1">Memuat…</span>}
          </div>

          {data && (
            <>
              {/* Hero match rate */}
              <div className="mx-4 sm:mx-5 mb-4 p-4 rounded-xl bg-gradient-to-br from-violet-50 to-slate-50 border border-violet-100 text-center">
                <p className="text-[11px] uppercase font-semibold text-violet-500 tracking-wider mb-1">
                  Match Analisa AI vs Supervisor
                </p>
                <p className="text-4xl font-bold text-violet-700">{matchRate.match_pct ?? 0}%</p>
                <p className="text-xs text-slate-500 mt-1">
                  {matchRate.agreed ?? 0} setuju · {matchRate.revised ?? 0} direvisi ·{' '}
                  {matchRate.reviewed_total ?? 0} direview
                </p>
              </div>

              {/* 2-col grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 px-4 sm:px-5 pb-4">
                {/* Issue breakdown */}
                <div className="border border-slate-100 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-slate-600 mb-3">
                    Issue Breakdown
                    <span className="ml-2 text-slate-400 font-normal">Total: {issueBreakdown.total ?? 0}</span>
                  </p>
                  {['A', 'B', 'C', 'D'].map((cat) => (
                    <CategoryBar key={cat} cat={cat} value={byCategory[cat] ?? 0} max={catMax} />
                  ))}
                  {issueBreakdown.aiQuality && (
                    <div className="pt-2 border-t border-slate-100 text-xs text-slate-500 space-y-0.5">
                      <p className="font-medium text-slate-600">AI Quality</p>
                      <p>Setuju {issueBreakdown.aiQuality.agreed} · Revisi {issueBreakdown.aiQuality.revised}</p>
                      <p>Match {issueBreakdown.aiQuality.match_pct}% dari {issueBreakdown.aiQuality.reviewed_total} direview</p>
                    </div>
                  )}
                </div>

                {/* Action breakdown / supervisor */}
                <div className="border border-slate-100 rounded-lg p-3">
                  <p className="text-xs font-semibold text-slate-600 mb-3">Action Breakdown</p>
                  {bySupervisor.length === 0 && (
                    <p className="text-xs text-slate-400">Belum ada data supervisor.</p>
                  )}
                  {bySupervisor.length > 0 && (
                    <table className="w-full text-xs mb-3">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500">
                          <th className="text-left px-2 py-1.5">Supervisor</th>
                          <th className="text-center px-2 py-1.5">Total</th>
                          <th className="text-center px-2 py-1.5">Solved</th>
                          <th className="text-center px-2 py-1.5">In Progress</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bySupervisor.map((sv) => (
                          <tr key={sv.supervisor_name} className="hover:bg-slate-50">
                            <td className="px-2 py-1.5 font-medium text-slate-700">{sv.supervisor_name}</td>
                            <td className="px-2 py-1.5 text-center text-slate-600">{sv.total}</td>
                            <td className="px-2 py-1.5 text-center text-emerald-700">{sv.solved}</td>
                            <td className="px-2 py-1.5 text-center text-amber-700">{sv.in_progress}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {/* Top-3 actions sample */}
                  {bySupervisor.some((sv) => sv.actions_sample?.length > 0) && (
                    <div>
                      <p className="text-[11px] uppercase text-slate-400 font-medium mb-1">Top Action Sample</p>
                      <ul className="space-y-1">
                        {bySupervisor
                          .flatMap((sv) => (sv.actions_sample || []).map((a) => ({ ...a, supervisor_name: sv.supervisor_name })))
                          .slice(0, 3)
                          .map((a, i) => (
                            <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                              <span className="text-slate-400 shrink-0">{i + 1}.</span>
                              <span className="line-clamp-2">{a.action || a.supervisor_todo || String(a)}</span>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Bubble Chat Progress */}
              <div className="px-4 sm:px-5 pb-4">
                <p className="text-xs font-semibold text-slate-600 mb-3">Bubble Chat Progress</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  <BubbleStat label="Total" value={bubbleProgress.total} color="text-slate-800" bg="bg-slate-50" />
                  <BubbleStat label="Closing" value={bubbleProgress.closing} color="text-emerald-700" bg="bg-emerald-50" />
                  <BubbleStat label="FU Done" value={bubbleProgress.fu_done} color="text-sky-700" bg="bg-sky-50" />
                  <BubbleStat label="Sales Balas" value={bubbleProgress.sales_replied} color="text-violet-700" bg="bg-violet-50" />
                  <BubbleStat label="Lost" value={bubbleProgress.lost} color="text-rose-700" bg="bg-rose-50" />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
