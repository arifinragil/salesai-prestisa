import { useState } from 'react';
import PipelineCard from './PipelineCard';
import PipelineLostModal from './PipelineLostModal';
import { api } from '@/lib/api';
import { useToast } from './Toast';

const STAGES = [
  { id: 'baru', label: 'Baru' },
  { id: 'tertarik', label: 'Tertarik' },
  { id: 'form_dikirim', label: 'Form Dikirim' },
  { id: 'order_submitted', label: 'Submitted' },
  { id: 'paid', label: 'Paid' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'lost', label: 'Lost' },
];

export default function PipelineMobile({ data, mutate }) {
  const toast = useToast();
  const [activeStage, setActiveStage] = useState('baru');
  const [convForMove, setConvForMove] = useState(null);
  const [lostFor, setLostFor] = useState(null);
  const stages = data?.stages || {};
  const list = stages[activeStage] || [];

  async function moveTo(stage, lostExtras) {
    try {
      await api(`/api/pipeline/conversations/${convForMove.id}/stage`, {
        method: 'POST',
        body: { stage, ...(lostExtras || {}) },
      });
      toast.success(`→ ${stage}`);
      setConvForMove(null);
      mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <>
      <div className="overflow-x-auto border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="flex gap-1 px-2 py-1">
          {STAGES.map((s) => (
            <button
              key={s.id} onClick={() => setActiveStage(s.id)}
              className={`px-3 py-1.5 text-xs rounded whitespace-nowrap ${
                activeStage === s.id ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {s.label} ({(stages[s.id] || []).length})
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 space-y-2">
        {list.length === 0 && <div className="text-center text-sm text-slate-400 py-6">Tidak ada deal di stage ini.</div>}
        {list.map((c) => (
          <div key={c.id} className="bg-white border border-slate-200 rounded-md p-2 flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <PipelineCard conv={c} onClick={() => window.open(`/inbox/${c.id}`, '_blank')} />
            </div>
            <button
              onClick={() => setConvForMove(c)}
              className="shrink-0 text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100"
            >⋯</button>
          </div>
        ))}
      </div>

      {convForMove && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center" onClick={() => setConvForMove(null)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-lg sm:rounded-lg p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="font-semibold text-slate-800 text-sm">Pindah ke stage…</div>
            {STAGES.filter((s) => s.id !== activeStage).map((s) => (
              <button
                key={s.id}
                onClick={() => s.id === 'lost' ? setLostFor(convForMove) : moveTo(s.id)}
                className="w-full text-left text-sm px-3 py-2 rounded hover:bg-slate-50 border border-slate-100"
              >{s.label}</button>
            ))}
            <button onClick={() => setConvForMove(null)} className="w-full text-center text-sm py-2 text-slate-500">Batal</button>
          </div>
        </div>
      )}

      <PipelineLostModal
        open={!!lostFor}
        onClose={() => { setLostFor(null); setConvForMove(null); }}
        onConfirm={({ reason, note }) => {
          moveTo('lost', { lost_reason: reason, lost_note: note || undefined });
          setLostFor(null);
        }}
      />
    </>
  );
}
