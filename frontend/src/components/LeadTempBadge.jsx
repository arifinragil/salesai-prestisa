// frontend/src/components/LeadTempBadge.jsx
// Small inline badge for lead temperature. Used in inbox list, chat header,
// and pipeline cards.

const STYLES = {
  hot:  { emoji: '🔥', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  warm: { emoji: '🌤️', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  cold: { emoji: '🧊', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

export default function LeadTempBadge({ temp, score, size = 'sm', showScore = false }) {
  if (!temp) return null;
  const style = STYLES[temp] || STYLES.cold;
  const px = size === 'xs' ? 'text-[10px] px-1 py-0' : 'text-xs px-1.5 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${style.cls} ${px} font-medium`}>
      <span aria-hidden>{style.emoji}</span>
      <span className="capitalize">{temp}</span>
      {showScore && typeof score === 'number' && (
        <span className="opacity-60">· {score}</span>
      )}
    </span>
  );
}
