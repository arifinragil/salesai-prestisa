// frontend/src/components/PerformanceTierPill.jsx
export function tierFor(score) {
  if (score == null) return { label: '—', emoji: '·', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (score >= 85) return { label: 'Excellent',   emoji: '🟢', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (score >= 70) return { label: 'Solid',       emoji: '🔵', cls: 'bg-sky-100 text-sky-700 border-sky-200' };
  if (score >= 55) return { label: 'Needs attn',  emoji: '🟡', cls: 'bg-amber-100 text-amber-700 border-amber-200' };
  return { label: 'Coaching',  emoji: '🔴', cls: 'bg-rose-100 text-rose-700 border-rose-200' };
}

export default function PerformanceTierPill({ score, showScore = false }) {
  const t = tierFor(typeof score === 'number' ? score : Number(score));
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${t.cls} text-xs px-2 py-0.5 font-medium`}>
      <span aria-hidden>{t.emoji}</span>
      <span>{t.label}</span>
      {showScore && score != null && <span className="opacity-70">· {Number(score).toFixed(0)}</span>}
    </span>
  );
}
