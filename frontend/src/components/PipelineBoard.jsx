import { useState } from 'react';
import PipelineCard from './PipelineCard';
import PipelineLostModal from './PipelineLostModal';
import { api } from '@/lib/api';
import { useToast } from './Toast';

const STAGES = [
  { id: 'baru', label: 'Baru' },
  { id: 'tertarik', label: 'Tertarik' },
  { id: 'form_dikirim', label: 'Form Dikirim' },
  { id: 'order_submitted', label: 'Order Submitted' },
  { id: 'paid', label: 'Paid' },
  { id: 'delivered', label: 'Delivered' },
];

export default function PipelineBoard({ data, mutate, collapseClosed }) {
  const toast = useToast();
  const [draggedConv, setDraggedConv] = useState(null);
  const [lostFor, setLostFor] = useState(null);

  const visibleStages = collapseClosed
    ? STAGES.filter((s) => s.id !== 'delivered')
    : STAGES;
  const stages = data?.stages || {};

  function sumValue(list) {
    const s = (list || []).reduce((acc, c) => acc + (Number(c.deal_value_idr) || 0), 0);
    return s ? `Rp ${s.toLocaleString('id-ID')}` : '—';
  }

  async function changeStage(convId, toStage, lostExtras) {
    try {
      const body = { stage: toStage, ...(lostExtras || {}) };
      await api(`/api/pipeline/conversations/${convId}/stage`, { method: 'POST', body });
      toast.success(`→ ${toStage}`);
      mutate();
    } catch (e) { toast.error(e.message); mutate(); }
  }

  function onDrop(toStage, e) {
    e.preventDefault();
    if (!draggedConv) return;
    if (draggedConv.pipeline_stage === toStage) { setDraggedConv(null); return; }
    if (toStage === 'lost') {
      setLostFor(draggedConv);
    } else {
      changeStage(draggedConv.id, toStage);
    }
    setDraggedConv(null);
  }

  return (
    <>
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-max">
          {visibleStages.map((s) => {
            const list = stages[s.id] || [];
            return (
              <div
                key={s.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(s.id, e)}
                className="w-[230px] shrink-0 bg-slate-50 border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-200px)]"
              >
                <div className="px-3 py-2 border-b border-slate-200 sticky top-0 bg-slate-50 z-10">
                  <div className="font-semibold text-slate-800 text-sm">{s.label} ({list.length})</div>
                  <div className="text-[11px] text-slate-500">{sumValue(list)}</div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {list.map((c) => (
                    <PipelineCard
                      key={c.id} conv={c}
                      draggable
                      onDragStart={() => setDraggedConv(c)}
                      onClick={() => window.open(`/inbox/${c.id}`, '_blank')}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {collapseClosed && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop('delivered', e)}
              className="w-[200px] shrink-0 bg-teal-50 border border-teal-200 rounded-lg p-2"
            >
              <div className="font-semibold text-teal-800 text-sm">Closed</div>
              <div className="text-[11px] text-teal-600">delivered + lost</div>
              <div className="text-xs text-slate-600 mt-2">
                Delivered: {(stages.delivered || []).length} · Lost: {(stages.lost || []).length}
              </div>
            </div>
          )}
        </div>
      </div>

      {!collapseClosed && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => onDrop('lost', e)}
          className="mt-4 bg-rose-50 border border-rose-200 rounded-lg p-3"
        >
          <div className="font-semibold text-rose-800 text-sm mb-2">Lost ({(stages.lost || []).length})</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {(stages.lost || []).slice(0, 20).map((c) => (
              <PipelineCard key={c.id} conv={c} onClick={() => window.open(`/inbox/${c.id}`, '_blank')} />
            ))}
          </div>
        </div>
      )}

      <PipelineLostModal
        open={!!lostFor}
        onClose={() => setLostFor(null)}
        onConfirm={({ reason, note }) => {
          changeStage(lostFor.id, 'lost', { lost_reason: reason, lost_note: note || undefined });
          setLostFor(null);
        }}
      />
    </>
  );
}
