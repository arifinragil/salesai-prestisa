import { formatRelative, formatPhone, formatDisplayName } from '@/lib/format';

const TYPE_ICON = {
  papan: '🪦',
  bouquet: '🌹',
  parsel: '🎁',
  cake: '🎂',
  wedding: '💍',
  b2b: '🏢',
  unknown: '❓',
};

const HEALTH_ICON = { vip: '⭐', warm: '🔥', cold: '❄', at_risk: '⚠', new: '' };

export default function PipelineCard({ conv, onClick, draggable, onDragStart }) {
  const phoneRaw = conv.real_phone || conv.phone;
  const phone = formatPhone(phoneRaw);
  const display = formatDisplayName(conv.push_name, phoneRaw);
  const isSamePhone = display === phone;
  const tempBorder =
    conv.lead_temperature === 'hot'  ? 'border-l-4 border-l-rose-400' :
    conv.lead_temperature === 'warm' ? 'border-l-4 border-l-amber-400' :
    '';
  return (
    <div
      role="button"
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      className={`bg-white border border-slate-200 rounded-md p-2 text-xs cursor-pointer hover:border-brand-300 hover:shadow-sm transition select-none ${tempBorder}`}
      title={`#${conv.id} · ${phone}`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="font-medium text-slate-800 truncate">{display}</div>
        {HEALTH_ICON[conv.health_band] && <span aria-hidden>{HEALTH_ICON[conv.health_band]}</span>}
      </div>
      {!isSamePhone && <div className="text-[10px] text-slate-500 truncate mt-0.5">{phone}</div>}
      <div className="flex items-center gap-1 mt-1 text-[11px]">
        <span aria-hidden>{TYPE_ICON[conv.pipeline_type] || TYPE_ICON.unknown}</span>
        <span className="text-slate-600">{conv.pipeline_type}</span>
      </div>
      {conv.deal_value_idr ? (
        <div className="text-[11px] font-medium text-emerald-700 mt-0.5">
          💰 Rp {Number(conv.deal_value_idr).toLocaleString('id-ID')}
        </div>
      ) : null}
      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
        <span>{conv.last_message_at ? formatRelative(conv.last_message_at) : '—'}</span>
        <span aria-hidden title={conv.manual_stage_override ? 'manual override' : 'auto'}>
          {conv.manual_stage_override ? '🔒' : '✨'}
        </span>
      </div>
    </div>
  );
}
