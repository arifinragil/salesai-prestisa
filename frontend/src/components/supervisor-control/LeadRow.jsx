function dot(color) { return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />; }

function Badge({ variant, lead }) {
  if (variant === 'waiting') {
    const m = Math.round(lead.awaiting_min || 0);
    const t = m >= 60 ? `${Math.floor(m/60)}j ${m%60}m` : `${m}m`;
    return <span className="text-xs text-rose-600 bg-rose-50 px-2 py-0.5 rounded">Tunggu {t}</span>;
  }
  if (variant === 'ghost') return <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Ghost {(lead.ghost_hours||0).toFixed(1)}j</span>;
  if (variant === 'promise') return <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Janji {lead.hours_since_promise}j lalu</span>;
  return <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded">{lead.lead_status || '-'}</span>;
}

export default function LeadRow({ lead, variant = 'stuck', onReview, onReviewDx, onCopy }) {
  const chatUrl = `/lotus-inbox/${encodeURIComponent(lead.lotus_id)}`;
  const dotColor = variant === 'waiting' || variant === 'promise' ? 'bg-rose-500' : variant === 'ghost' ? 'bg-amber-500' : 'bg-slate-300';
  const copyText = variant === 'promise'
    ? `Halo Kak ${lead.cust_name || ''}, mohon maaf — update untuk request sebelumnya ya kak 🙏`
    : `Halo Kak ${lead.cust_name || ''}, ada yang bisa kami bantu lanjut ya kak? 😊`;
  return (
    <div className="px-4 sm:px-6 py-3 border-b border-slate-100 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {dot(dotColor)}
          <span className="font-semibold text-slate-800 truncate">{lead.cust_name || lead.lotus_id}</span>
          {lead.pic_name && <span className="text-sm text-slate-400">· {lead.pic_name}</span>}
          <span className="sm:hidden ml-auto"><Badge variant={variant} lead={lead} /></span>
        </div>
        {variant === 'promise' && lead.promise_body && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-1">"{lead.promise_body}"</p>
        )}
        {lead.last_message && <p className="text-sm text-slate-600 mt-1 line-clamp-2">{lead.last_message}</p>}
        <p className="text-xs text-slate-400 mt-1">
          Stage <span className="font-medium text-slate-600">{lead.lead_status || '-'}</span>
          {lead.lead_temperature && <> · Temp <span className="font-medium text-slate-600">{lead.lead_temperature}</span></>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="hidden sm:inline"><Badge variant={variant} lead={lead} /></span>
        <a href={chatUrl} target="_blank" rel="noreferrer" className="text-xs px-3 py-2 rounded-md bg-slate-900 text-white inline-flex items-center gap-1">💬 Chat</a>
        {(variant === 'waiting' || variant === 'promise' || variant === 'ghost') && (
          <button onClick={() => (onCopy ? onCopy(copyText) : navigator.clipboard?.writeText(copyText))}
            className="text-xs px-3 py-2 rounded-md border border-slate-200 text-slate-700 inline-flex items-center gap-1">⧉ {variant === 'ghost' ? 'Salin tip' : 'Salin remind'}</button>
        )}
        {variant === 'stuck' && (
          <>
            <button onClick={() => onReviewDx && onReviewDx(lead)} className="text-xs px-3 py-2 rounded-md border border-violet-200 text-violet-700 inline-flex items-center gap-1">✳ Review Dx</button>
            <button onClick={() => onReview && onReview(lead)} className="text-xs px-3 py-2 rounded-md border border-emerald-200 text-emerald-700 inline-flex items-center gap-1">✓ Review</button>
          </>
        )}
      </div>
    </div>
  );
}
