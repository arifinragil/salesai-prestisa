export default function PrioritySummary({ priority, onJump }) {
  if (!priority) return null;
  const p = priority;
  const Box = ({ tone, code, label, n, sub }) => (
    <button onClick={() => onJump && onJump(code)} className="text-left flex-1 px-4 py-3">
      <div className="text-xs uppercase tracking-wide" style={{ opacity: 0.7 }}><span className={tone}>{code}</span> {label}</div>
      <div className="text-4xl font-bold leading-tight">{n}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </button>
  );
  return (
    <div className="sticky top-0 z-20 bg-slate-900 text-white rounded-xl overflow-hidden mb-4">
      <div className="px-4 py-2 flex items-center justify-between border-b border-white/10">
        <div><div className="text-xs uppercase tracking-widest text-slate-400">Priority Queue</div><div className="text-sm text-slate-300">Tap untuk lompat ke grup</div></div>
        <div className="text-right"><div className="text-3xl font-bold">{p.total}</div><div className="text-xs text-slate-400">total perlu aksi</div></div>
      </div>
      <div className="flex flex-col xs:flex-row divide-y xs:divide-y-0 xs:divide-x divide-white/10">
        <Box tone="text-rose-400" code="P1" label="Kritikal" n={p.p1} sub={`${p.p1Items?.customerWaitingCritical ?? 0} wait · ${p.p1Items?.leadNoReply ?? 0} belum dibalas · ${p.p1Items?.salesPromiseBroken ?? 0} janji`} />
        <Box tone="text-amber-400" code="P2" label="Follow Up" n={p.p2} sub={`${p.p2Items?.customerGhost ?? 0} ghost · ${p.p2Items?.fuCycleIncomplete ?? 0} FU telat · ${p.p2Items?.leadStuck ?? 0} stuck`} />
        <Box tone="text-sky-400" code="P3" label="Monitor" n={p.p3} sub={`${p.p3Items?.bubbleChat ?? 0} bubble · ${p.p3Items?.slowFirstResponseMild ?? 0} balas lambat`} />
      </div>
    </div>
  );
}
