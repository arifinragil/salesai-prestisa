// frontend/src/components/lotus-inbox/TodayTasksCard.jsx
export default function TodayTasksCard({ counts = {}, onPick }) {
  const urgent = counts.urgent || 0;
  const baru = counts.customer_baru || 0;
  const tunggu = counts.tunggu_balas || 0;
  const fuOverdue = counts.fu_overdue || 0;
  const fuPending = counts.fu_pending || 0;

  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">Tugas kamu hari ini</div>
        <div className="flex flex-wrap gap-2">
          <Chip n={urgent}  label="Urgent"        tone="rose"    onClick={() => onPick('urgent')} />
          <Chip n={baru}    label="Customer Baru" tone="emerald" onClick={() => onPick('customer_baru')} />
          <Chip n={tunggu}  label="Tunggu Balas"  tone="amber"   onClick={() => onPick('tunggu_balas')} />
        </div>
      </div>

      {fuOverdue > 0 ? (
        <button onClick={() => onPick('fu_overdue')}
          className="w-full text-left bg-rose-600 text-white rounded-xl px-4 py-3 flex items-center justify-between">
          <span>
            <span className="font-semibold">{fuOverdue} FU overdue — kerjakan sekarang!</span>
            <span className="block text-xs text-rose-100 mt-0.5">{fuPending} FU pending (H+1/H+3/H+5)</span>
          </span>
          <span className="text-sm bg-white/20 px-3 py-1 rounded-lg whitespace-nowrap">Buka Tugas →</span>
        </button>
      ) : urgent > 0 ? (
        <button onClick={() => onPick('urgent')}
          className="w-full text-left bg-rose-600 text-white rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="font-semibold">{urgent} lead belum direspons — balas sekarang!</span>
          <span className="text-sm bg-white/20 px-3 py-1 rounded-lg">Buka →</span>
        </button>
      ) : null}
    </div>
  );
}

const TONES = {
  rose: 'border-rose-200 text-rose-700',
  emerald: 'border-emerald-200 text-emerald-700',
  amber: 'border-amber-200 text-amber-700',
};
function Chip({ n, label, tone, onClick }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-white ${TONES[tone] || ''}`}>
      <span className="text-base font-bold">{n || 0}</span>
      <span className="text-xs">{label}</span>
    </button>
  );
}
