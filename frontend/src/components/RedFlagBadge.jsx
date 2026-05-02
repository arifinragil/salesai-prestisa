// frontend/src/components/RedFlagBadge.jsx
const STYLE = {
  critical: { emoji: '🚨', cls: 'bg-rose-100 text-rose-700 border-rose-300' },
  high:     { emoji: '⚠',  cls: 'bg-orange-100 text-orange-700 border-orange-300' },
  medium:   { emoji: '⚡', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  low:      { emoji: '·',  cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

export default function RedFlagBadge({ severity, count, size = 'sm' }) {
  if (!severity) return null;
  const s = STYLE[severity] || STYLE.low;
  const px = size === 'xs' ? 'text-[10px] px-1 py-0' : 'text-xs px-1.5 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${s.cls} ${px} font-medium`} title={severity}>
      <span aria-hidden>{s.emoji}</span>
      <span className="capitalize">{severity}</span>
      {typeof count === 'number' && count > 1 && <span className="opacity-70">×{count}</span>}
    </span>
  );
}
