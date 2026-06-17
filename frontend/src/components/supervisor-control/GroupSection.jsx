// frontend/src/components/supervisor-control/GroupSection.jsx
import LeadCard from './LeadCard';
export default function GroupSection({ title, icon, items = [], onAction, extra, buckets, total }) {
  const shown = buckets ? Object.values(buckets).reduce((s, a) => s + a.length, 0) : items.length;
  const count = total ?? shown;
  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
        <span>{icon}</span><h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <span className="text-xs text-slate-400">({count}{count > shown ? ` · tampil ${shown}` : ''})</span>
      </div>
      {count === 0 && <div className="px-4 py-6 text-center text-xs text-slate-400">Tidak ada lead</div>}
      {buckets ? (
        Object.entries(buckets).map(([b, arr]) => arr.length > 0 && (
          <div key={b}>
            <div className="px-4 py-1 bg-slate-100/60 text-[11px] font-semibold text-slate-500">{BUCKET_LABEL[b]}</div>
            {arr.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)} extra={extra} />)}
          </div>
        ))
      ) : items.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)} extra={extra} />)}
    </div>
  );
}
const BUCKET_LABEL = { A: 'A · Issue dari Customer', B: 'B · Issue dari Sales Handling', C: 'C · Issue dari Offer / Produk', D: 'D · Issue dari Proses' };
