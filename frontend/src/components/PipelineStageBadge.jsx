const STAGE_COLOR = {
  baru:            'bg-slate-100 text-slate-700 border-slate-200',
  tertarik:        'bg-blue-100 text-blue-700 border-blue-200',
  form_dikirim:    'bg-indigo-100 text-indigo-700 border-indigo-200',
  order_submitted: 'bg-violet-100 text-violet-700 border-violet-200',
  paid:            'bg-emerald-100 text-emerald-700 border-emerald-200',
  delivered:       'bg-teal-100 text-teal-700 border-teal-200',
  lost:            'bg-rose-100 text-rose-700 border-rose-200',
};

const STAGE_LABEL = {
  baru: 'Baru',
  tertarik: 'Tertarik',
  form_dikirim: 'Form Dikirim',
  order_submitted: 'Submitted',
  paid: 'Paid',
  delivered: 'Delivered',
  lost: 'Lost',
};

export default function PipelineStageBadge({ stage, override, size = 'sm', title }) {
  if (!stage) return null;
  const cls = STAGE_COLOR[stage] || STAGE_COLOR.baru;
  const sz = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${cls} ${sz}`} title={title || stage}>
      {STAGE_LABEL[stage] || stage}
      {override && <span aria-hidden title="manual override">🔒</span>}
    </span>
  );
}

export { STAGE_COLOR, STAGE_LABEL };
