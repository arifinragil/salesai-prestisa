import { useState } from 'react';

const REASONS = [
  ['no_reply', 'Customer ghosting / no reply'],
  ['harga_terlalu_tinggi', 'Harga terlalu tinggi'],
  ['kompetitor', 'Pindah ke kompetitor'],
  ['produk_tidak_cocok', 'Produk tidak cocok'],
  ['timing_tidak_pas', 'Timing tidak pas / event lewat'],
  ['cancelled', 'Customer cancel eksplisit'],
  ['refund_complaint', 'Komplain berakhir refund'],
  ['other_with_note', 'Lainnya (isi note)'],
];

export default function PipelineLostModal({ open, onClose, onConfirm }) {
  const [reason, setReason] = useState('no_reply');
  const [note, setNote] = useState('');
  if (!open) return null;
  const needsNote = reason === 'other_with_note';
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-semibold text-slate-800">Mark deal as Lost</h3>
        <div className="space-y-1">
          {REASONS.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="lost_reason" checked={reason === id} onChange={() => setReason(id)} />
              {label}
            </label>
          ))}
        </div>
        {needsNote && (
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (wajib)…"
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded">Batal</button>
          <button
            onClick={() => onConfirm({ reason, note: note.trim() })}
            disabled={needsNote && !note.trim()}
            className="text-sm px-3 py-1.5 rounded bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">
            Konfirmasi Lost
          </button>
        </div>
      </div>
    </div>
  );
}
