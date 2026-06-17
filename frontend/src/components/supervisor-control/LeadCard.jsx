// frontend/src/components/supervisor-control/LeadCard.jsx
import { useState } from 'react';
import DiagnosisPanel from './DiagnosisPanel';

const TIER = { P1: 'bg-rose-100 text-rose-700 border-rose-300', P2: 'bg-amber-100 text-amber-700 border-amber-300', P3: 'bg-yellow-50 text-yellow-700 border-yellow-200' };
function dur(it) {
  if (it.never_responded) return 'belum direspons';
  if (it.last_message_from && /^(in|customer)/i.test(it.last_message_from)) return `belum dibalas ${Math.round(it.awaiting_min || 0)} mnt`;
  return `cust diam ${Math.round(it.awaiting_min || 0)} mnt`;
}
export default function LeadCard({ item, onAction, extra }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
        {item.priority && <span className={`px-1.5 py-0.5 rounded border text-[11px] font-bold ${TIER[item.priority] || ''}`}>{item.priority}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800 truncate">{item.cust_name || '(tanpa nama)'}</span>
            {item.pic_name && <span className="text-xs text-slate-400">PIC: {item.pic_name}</span>}
            {item.stuck_label && <span className="text-[11px] px-1.5 rounded bg-slate-100 text-slate-500">{item.stuck_label}</span>}
          </div>
          <div className="text-xs text-slate-500 truncate">{/^(in|customer)/i.test(item.last_message_from || '') ? '⬅︎ ' : '➡︎ '}{item.last_message || ''}</div>
          {extra && <div className="text-[11px] text-slate-400 mt-0.5">{extra(item)}</div>}
        </div>
        <span className="text-xs text-rose-600 whitespace-nowrap">{dur(item)}</span>
        <div className="flex gap-1.5">
          <a href={`/lotus-inbox/${item.lotus_id}`} className="px-2 py-1 rounded bg-sky-600 text-white text-xs">Chat</a>
          <button onClick={() => onAction('ack', { note: 'analisa sesuai' })} className="px-2 py-1 rounded bg-emerald-600 text-white text-xs">Ack</button>
          <button onClick={() => setOpen((v) => !v)} className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-xs">{open ? '▴' : '▾ Diagnosa'}</button>
        </div>
      </div>
      {open && <DiagnosisPanel lead={item} onAction={onAction} />}
    </div>
  );
}
