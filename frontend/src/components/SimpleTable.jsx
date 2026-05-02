// Tiny presentational table — used by all CRUD admin pages.
// Cells are rendered via per-column render fn so callers stay in control.
export default function SimpleTable({ columns, rows, empty = 'Tidak ada data.' }) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-left text-xs uppercase tracking-wide">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2 font-medium ${c.headClass || ''}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-400">
                  {empty}
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id ?? i} className="hover:bg-slate-50">
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 align-top ${c.cellClass || ''}`}>
                    {c.render ? c.render(r) : r[c.key] ?? <span className="text-slate-300">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
