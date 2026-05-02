import { useState } from 'react';
import useSWR from 'swr';
import { formatRelative } from '@/lib/format';
import { api, fetcher } from '@/lib/api';
import { useToast } from './Toast';

const ESC_LABEL = {
  ai_bug: 'AI bermasalah',
  data_missing: 'Info kosong di KB/DB',
  out_of_scope: 'Di luar wewenang AI',
  customer_request: 'Customer minta human',
};

const REASON_LABEL = {
  complaint: 'Komplain',
  refund: 'Refund',
  cancel: 'Cancel',
  custom_price: 'Custom price',
  explicit_request_human: 'Customer minta orang',
  low_confidence: 'AI tidak yakin',
  tool_error: 'Tool error',
  other: 'Lainnya',
  legal: 'Legal',
  angry: 'Customer marah',
};

export default function HandoverBanner({ handovers = [], onResolved }) {
  const toast = useToast();
  const [showDetail, setShowDetail] = useState(false);
  const open = handovers.filter((h) => !h.resolved_at);
  const latest = open[0];
  const detail = useSWR(
    latest && showDetail ? `/api/inbox/handovers/${latest.id}/detail` : null,
    fetcher
  );
  if (!open.length) return null;
  const reasonLabel = REASON_LABEL[latest.reason] || latest.reason;

  async function resolve() {
    try {
      await api(`/api/inbox/handovers/${latest.id}/resolve`, { method: 'POST' });
      toast.success('Handover ditandai selesai');
      onResolved?.();
    } catch (e) {
      toast.error(e.message || 'Gagal resolve');
    }
  }

  return (
    <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-rose-800">
            Handover aktif: {reasonLabel}
          </div>
          {latest.detail && (
            <div className="text-xs text-rose-700 mt-0.5">{latest.detail}</div>
          )}
          {latest.brief && (
            <div className="text-xs text-rose-900 mt-2 p-2 rounded bg-white/70 border border-rose-200 whitespace-pre-wrap">
              <span className="font-semibold">Brief AI: </span>{latest.brief}
            </div>
          )}
          {latest.escalation_class && (
            <div className="text-[11px] text-rose-700 mt-1">
              Klasifikasi: <span className="font-medium">{ESC_LABEL[latest.escalation_class] || latest.escalation_class}</span>
            </div>
          )}
          <button onClick={() => setShowDetail((v) => !v)} className="text-[11px] text-rose-600 underline mt-1">
            {showDetail ? 'Tutup detail' : 'Lihat detail percakapan + fakta'}
          </button>
          {showDetail && detail.data && (
            <div className="mt-2 space-y-2 text-xs">
              {Array.isArray(detail.data.facts) && detail.data.facts.length > 0 && (
                <div className="rounded bg-white/70 border border-rose-200 p-2">
                  <div className="font-semibold text-rose-800 mb-1">Fakta dari chat</div>
                  <ul className="space-y-0.5">
                    {detail.data.facts.map((f) => (
                      <li key={f.fact_key} className="flex gap-2">
                        <span className="text-slate-500 capitalize w-32 shrink-0">{f.fact_key.replace(/_/g, ' ')}</span>
                        <span className="text-slate-800 break-words">{f.fact_value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {Array.isArray(detail.data.turns) && (
                <div className="rounded bg-white/70 border border-rose-200 p-2">
                  <div className="font-semibold text-rose-800 mb-1">7 turn terakhir</div>
                  <ul className="space-y-1 max-h-48 overflow-y-auto">
                    {detail.data.turns.map((t, i) => (
                      <li key={i} className="text-slate-800">
                        <span className="text-[10px] uppercase text-slate-500 mr-1">
                          {t.direction === 'in' ? 'cust' : (t.sender_type === 'ai' ? 'ai' : 'op')}
                        </span>
                        {t.body}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="text-xs text-rose-500 mt-1">
            {formatRelative(latest.created_at)}
            {open.length > 1 && ` · +${open.length - 1} lainnya`}
          </div>
        </div>
        <button
          onClick={resolve}
          className="text-xs px-3 py-1.5 rounded-md bg-white border border-rose-300 text-rose-700 hover:bg-rose-100"
        >
          Resolve
        </button>
      </div>
    </div>
  );
}
