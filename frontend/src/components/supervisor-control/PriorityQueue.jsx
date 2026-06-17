// frontend/src/components/supervisor-control/PriorityQueue.jsx
import LeadCard from './LeadCard';
export default function PriorityQueue({ items = [], counts = {}, onAction }) {
  return (
    <div className="bg-white border-2 border-rose-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 flex items-center gap-2">
        <span>🎯</span><h2 className="text-sm font-semibold text-rose-800">Priority Lead Queue</h2>
        <span className="text-xs text-rose-600">🔴 {counts.P1 || 0} · 🟠 {counts.P2 || 0} · 🟡 {counts.P3 || 0}</span>
      </div>
      {items.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-400">Tidak ada lead prioritas 🎉</div>}
      {items.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)}
        extra={(i) => `${i.fu_status === 'overdue' ? 'FU overdue · ' : ''}cycle FU ${i.fu_current_cycle}/3 · ${i.fu_count_today} FU hari ini`} />)}
    </div>
  );
}
