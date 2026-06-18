import LeadRow from './LeadRow';

export default function CycleSplit({ cycles = { 1: [], 2: [], 3: [] } }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-3">
      {[1, 2, 3].map((c) => (
        <div key={c} className="border border-slate-100 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-600">
            Cycle {c} overdue{' '}
            <span className="text-rose-500">({(cycles[c] || []).length})</span>
          </div>
          <div>
            {(cycles[c] || []).length
              ? cycles[c].map((l) => <LeadRow key={l.lotus_id} lead={l} variant="ghost" />)
              : <p className="text-xs text-slate-400 px-3 py-3">Tidak ada.</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
