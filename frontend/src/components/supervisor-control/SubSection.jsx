export default function SubSection({ icon, title, count, situation, actionHint, children }) {
  return (
    <div className="border-t border-slate-100">
      <div className="px-4 sm:px-6 py-3 bg-amber-50/40">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 shrink-0 rounded-full bg-brand-50 inline-flex items-center justify-center text-lg">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-slate-800 text-sm uppercase tracking-wide">{title}</h4>
              {count > 0 && <span className="text-xs font-bold text-white bg-rose-500 rounded-full px-2 py-0.5">{count}</span>}
            </div>
            {situation && <p className="text-sm text-slate-600 mt-0.5">{situation}</p>}
            {actionHint && <p className="text-sm text-brand-700 mt-0.5">→ {actionHint}</p>}
          </div>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
