import { formatRelative } from '@/lib/format';
import { api } from '@/lib/api';
import { useToast } from './Toast';

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
  const open = handovers.filter((h) => !h.resolved_at);
  if (!open.length) return null;

  const latest = open[0];
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
