import useSWR from 'swr';
import { fetcher } from '@/lib/api';

export default function PipelineForecastPanel({ open, onClose, type }) {
  const url = `/api/pipeline/forecast?days=30${type ? `&type=${type}` : ''}`;
  const { data } = useSWR(open ? url : null, fetcher, { refreshInterval: 60_000 });
  if (!open) return null;
  return (
    <aside className="fixed top-0 right-0 bottom-0 w-80 bg-white border-l border-slate-200 shadow-xl z-40 overflow-y-auto" role="dialog" aria-label="Forecast panel">
      <div className="p-4 border-b border-slate-200 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">📊 Forecast 30d</h3>
        <button onClick={onClose} className="text-slate-500 hover:bg-slate-100 rounded w-8 h-8 inline-flex items-center justify-center">✕</button>
      </div>
      {!data ? (
        <div className="p-4 text-sm text-slate-400">Loading…</div>
      ) : (
        <div className="p-4 space-y-4 text-sm">
          <div>
            <div className="text-xs text-slate-500 uppercase">Expected revenue</div>
            <div className="text-xl font-semibold text-brand-800">Rp {Number(data.expected_revenue || 0).toLocaleString('id-ID')}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 uppercase">Realized 30d (delivered)</div>
            <div className="text-xl font-semibold text-emerald-700">Rp {Number(data.realized_revenue_30d || 0).toLocaleString('id-ID')}</div>
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Conversion rate</div>
            {Object.entries(data.conversion_rates || {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{k}</span>
                <span className="font-medium">{Math.round((Number(v) || 0) * 100)}%</span>
              </div>
            ))}
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Avg time per stage</div>
            {Object.entries(data.avg_time_per_stage_seconds || {}).map(([s, sec]) => (
              <div key={s} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{s}</span>
                <span className="font-medium">
                  {sec < 60 ? `${sec}d` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}j`}
                </span>
              </div>
            ))}
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Top Lost reason</div>
            {(data.top_lost_reasons || []).map((r) => (
              <div key={r.lost_reason} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{r.lost_reason}</span>
                <span className="font-medium">{r.n}</span>
              </div>
            ))}
            {!(data.top_lost_reasons || []).length && <div className="text-xs text-slate-400">tidak ada</div>}
          </div>
        </div>
      )}
    </aside>
  );
}
