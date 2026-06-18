import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import ReviewForm from './ReviewForm';

const RANGE_PRESETS = [
  { label: '7 Hari', value: 7 },
  { label: '30 Hari', value: 30 },
  { label: '90 Hari', value: 90 },
];

const FILTER_OPTS = [
  { label: 'Semua', value: 'all' },
  { label: 'Belum direview', value: 'not_reviewed' },
  { label: 'In Progress', value: 'reviewed_open' },
  { label: 'Solved', value: 'solved' },
];

function KpiBox({ label, value, color = 'text-slate-800', bg = 'bg-slate-50' }) {
  return (
    <div className={`flex flex-col items-center px-3 py-3 rounded-lg border border-slate-100 ${bg}`}>
      <span className={`text-2xl font-bold ${color}`}>{value ?? '—'}</span>
      <span className="text-[11px] text-slate-500 mt-0.5 text-center">{label}</span>
    </div>
  );
}

function ComplianceBar({ pct = 0 }) {
  const p = Math.min(100, Math.max(0, pct));
  const color = p >= 80 ? 'bg-emerald-500' : p >= 50 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${p}%` }} />
      </div>
      <span className={`text-sm font-semibold ${p >= 80 ? 'text-emerald-700' : p >= 50 ? 'text-amber-700' : 'text-rose-700'}`}>
        {p}%
      </span>
    </div>
  );
}

export default function ActionTrackerCard() {
  const [open, setOpen] = useState(true);
  const [range, setRange] = useState(7);
  const [filter, setFilter] = useState('all');
  const [reviewingId, setReviewingId] = useState(null);

  const { data, mutate, error } = useSWR(
    `/api/supervisor-control/actions?range=${range}`,
    fetcher
  );

  const summary = data?.summary || {};
  const bySupervisor = data?.bySupervisor || [];
  const allTasks = data?.tasks || [];

  const filteredTasks = filter === 'all'
    ? allTasks
    : allTasks.filter((t) => {
      if (filter === 'not_reviewed') return !t.supervisor_ack_at;
      if (filter === 'reviewed_open') return t.supervisor_ack_at && !t.supervisor_solved;
      if (filter === 'solved') return t.supervisor_solved;
      return true;
    });

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 sm:px-5 py-4 flex items-start sm:items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base">📋</span>
            <h2 className="text-sm font-semibold text-slate-800">
              Action Tracker — Supervisor Compliance
            </h2>
          </div>
          {data && (
            <p className="text-xs text-slate-500 mt-0.5 pl-6">
              {summary.total ?? 0} tugas ·{' '}
              {summary.compliance_pct ?? 0}% compliance
            </p>
          )}
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {/* Range selector */}
          <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-2">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setRange(p.value)}
                className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                  range === p.value
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'border-slate-200 text-slate-600'
                }`}
              >
                {p.label}
              </button>
            ))}
            {error && <span className="text-xs text-rose-500 ml-2">Gagal memuat data.</span>}
            {!data && !error && <span className="text-xs text-slate-400 ml-2">Memuat…</span>}
          </div>

          {data && (
            <>
              {/* KPI boxes */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 sm:px-5 pb-4">
                <KpiBox label="Total Tugas" value={summary.total} color="text-slate-800" bg="bg-slate-50" />
                <KpiBox label="Solved" value={summary.done} color="text-emerald-700" bg="bg-emerald-50" />
                <KpiBox label="In Progress" value={summary.reviewed_open} color="text-sky-700" bg="bg-sky-50" />
                <KpiBox label="Belum Direview" value={summary.not_reviewed} color="text-rose-700" bg="bg-rose-50" />
              </div>

              {/* Compliance bar */}
              <div className="px-4 sm:px-5 pb-4">
                <p className="text-xs font-semibold text-slate-600 mb-2">
                  Compliance Rate ({summary.compliance_pct ?? 0}%)
                </p>
                <ComplianceBar pct={summary.compliance_pct} />
              </div>

              {/* Per-supervisor table */}
              {bySupervisor.length > 0 && (
                <div className="px-4 sm:px-5 pb-4">
                  <p className="text-xs font-semibold text-slate-600 mb-2">Per Supervisor</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500">
                          <th className="text-left px-3 py-2 rounded-tl-md">Supervisor</th>
                          <th className="text-center px-3 py-2">Handled</th>
                          <th className="text-center px-3 py-2">Done</th>
                          <th className="text-center px-3 py-2">Open</th>
                          <th className="text-center px-3 py-2 rounded-tr-md">Compliance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {bySupervisor.map((sv) => (
                          <tr key={sv.supervisor_name} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-medium text-slate-700">{sv.supervisor_name}</td>
                            <td className="px-3 py-2 text-center text-slate-600">{sv.handled}</td>
                            <td className="px-3 py-2 text-center text-emerald-700">{sv.done}</td>
                            <td className="px-3 py-2 text-center text-amber-700">{sv.open}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`font-semibold ${
                                sv.compliance_pct >= 80 ? 'text-emerald-700' :
                                sv.compliance_pct >= 50 ? 'text-amber-700' : 'text-rose-700'
                              }`}>
                                {sv.compliance_pct}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Filter pills */}
              <div className="px-4 sm:px-5 pb-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                {FILTER_OPTS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setFilter(opt.value)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      filter === opt.value
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'border-slate-200 text-slate-600'
                    }`}
                  >
                    {opt.label}
                    {opt.value === 'not_reviewed' && summary.not_reviewed > 0 && (
                      <span className="ml-1 bg-rose-500 text-white text-[10px] rounded-full px-1.5 py-0.5">
                        {summary.not_reviewed}
                      </span>
                    )}
                  </button>
                ))}
                <span className="text-xs text-slate-400 self-center ml-auto">
                  {filteredTasks.length} tugas
                </span>
              </div>

              {/* Task backlog list */}
              <div className="divide-y divide-slate-100">
                {filteredTasks.length === 0 && (
                  <p className="text-xs text-slate-400 px-4 sm:px-5 py-4">Tidak ada tugas.</p>
                )}
                {filteredTasks.map((t) => (
                  <div key={t.lotus_id}>
                    <div className="px-4 sm:px-5 py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-800">{t.lotus_id}</span>
                          {t.supervisor_name && (
                            <span className="text-xs text-slate-400">{t.supervisor_name}</span>
                          )}
                          {t.root_cause_tag && (
                            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                              {t.root_cause_tag}
                            </span>
                          )}
                          {t.stuck_group && (
                            <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">
                              {t.stuck_group}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          {t.supervisor_solved ? (
                            <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">Solved</span>
                          ) : t.supervisor_ack_at ? (
                            <span className="text-xs bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full">In Progress</span>
                          ) : (
                            <span className="text-xs bg-rose-100 text-rose-700 px-2 py-0.5 rounded-full">Belum direview</span>
                          )}
                          {t.supervisor_ack_at && (
                            <span className="text-xs text-slate-400">
                              {new Date(t.supervisor_ack_at).toLocaleDateString('id-ID')}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setReviewingId(reviewingId === t.lotus_id ? null : t.lotus_id)}
                        className="text-xs px-3 py-1.5 rounded-md border border-emerald-200 text-emerald-700 shrink-0"
                      >
                        {reviewingId === t.lotus_id ? 'Tutup' : 'Review sekarang'}
                      </button>
                    </div>
                    {reviewingId === t.lotus_id && (
                      <ReviewForm
                        lead={{ lotus_id: t.lotus_id, ...t }}
                        onDone={() => { mutate(); setReviewingId(null); }}
                        onCancel={() => setReviewingId(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
