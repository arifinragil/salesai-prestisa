import { useState } from 'react';
import { api } from '@/lib/api';

const CATS = [
  { v: 'customer', label: 'Customer' },
  { v: 'sales_handling', label: 'Sales Handling' },
  { v: 'offer', label: 'Offer' },
  { v: 'process', label: 'Process' },
];
const OUTCOMES = [
  { v: 'closing', label: '✓ Closing — order masuk', cls: 'border-emerald-300 text-emerald-700' },
  { v: 'lost', label: '✕ Lost — tidak deal', cls: 'border-rose-300 text-rose-700' },
  { v: 'parked', label: '‖ Parked — di-pause', cls: 'border-slate-300 text-slate-700' },
  { v: 'still_fu', label: '↻ FU lanjutan', cls: 'border-amber-300 text-amber-700' },
  { v: 'unknown', label: '? Belum tahu', cls: 'border-slate-300 text-slate-600' },
];

function Seg({ value, set, options }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={String(o.v)} type="button" onClick={() => set(o.v)}
          className={`text-sm px-3 py-2 rounded-md border ${value === o.v ? 'bg-slate-900 text-white border-slate-900' : 'border-slate-200 text-slate-700'}`}>{o.label}</button>
      ))}
    </div>
  );
}

export default function ReviewForm({ lead, onDone, onCancel }) {
  const [agree, setAgree] = useState(null);
  const [category, setCategory] = useState('');
  const [subtype, setSubtype] = useState('');
  const [note, setNote] = useState('');
  const [solved, setSolved] = useState(null);
  const [todo, setTodo] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const canSubmit = agree !== null && solved !== null && todo.trim() && (agree !== false || note.trim());

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setErr('');
    try {
      await api(`/api/supervisor-control/diagnosis/${lead.lotus_id}/review`, { method: 'POST', body: {
        agree_with_ai: agree, revise_category: category || null, revise_subtype: subtype || null,
        revise_note: note || null, solved, supervisor_todo: todo, supervisor_outcome: outcome || null } });
      onDone && onDone();
    } catch (e) { setErr(e.message || 'Gagal simpan'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-emerald-50/30 border-t border-emerald-100 px-4 sm:px-6 py-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2"><span className="text-violet-600">1</span> Analisa AI sesuai dengan kondisi sebenarnya?</p>
        <Seg value={agree} set={setAgree} options={[{ v: true, label: '✓ Setuju' }, { v: false, label: 'Tidak setuju' }]} />
      </div>
      {agree === false && (
        <div className="space-y-2 pl-4 border-l-2 border-violet-200">
          <p className="text-sm font-semibold text-slate-700">Kategori yang benar:</p>
          <div className="flex flex-wrap gap-2">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="text-sm border border-slate-200 rounded-md px-3 py-2">
              <option value="">— Pilih —</option>
              {CATS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
            </select>
            <input value={subtype} onChange={(e) => setSubtype(e.target.value)} placeholder="subtype (opsional)" className="text-sm border border-slate-200 rounded-md px-3 py-2 flex-1" />
          </div>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Analisa yang benar menurut supervisor (wajib)" rows={2} className="w-full text-sm border border-slate-200 rounded-md px-3 py-2" />
        </div>
      )}
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2"><span className="text-violet-600">2</span> Isu sudah solve?</p>
        <Seg value={solved} set={setSolved} options={[{ v: true, label: '✓ Ya, sudah solve' }, { v: false, label: 'Belum, butuh tindak lanjut' }]} />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2"><span className="text-violet-600">3</span> Action supervisor — apa yang sudah / akan dilakukan? <span className="text-rose-500">*</span></p>
        <textarea value={todo} onChange={(e) => setTodo(e.target.value)} rows={2} placeholder="Contoh: Sudah remind sales via WA + pair-up sesi closing hari ini." className="w-full text-sm border border-slate-200 rounded-md px-3 py-2" />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-700 mb-2"><span className="text-violet-600">4</span> Hasil akhir / outcome <span className="text-slate-400 font-normal">(opsional)</span></p>
        <div className="flex flex-wrap gap-2">
          {OUTCOMES.map((o) => (
            <button key={o.v} type="button" onClick={() => setOutcome(outcome === o.v ? '' : o.v)}
              className={`text-sm px-3 py-2 rounded-md border ${outcome === o.v ? 'bg-white ' + o.cls : 'border-slate-200 text-slate-600'}`}>{o.label}</button>
          ))}
        </div>
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="flex items-center gap-3">
        <button disabled={!canSubmit || busy} onClick={submit}
          className="text-sm px-4 py-2 rounded-md bg-violet-600 text-white disabled:opacity-50">{busy ? '…' : '✓ Simpan review'}</button>
        <button onClick={onCancel} className="text-sm text-slate-500">Batal</button>
        {!canSubmit && <span className="text-xs text-slate-400 italic">Isi field action dulu</span>}
      </div>
    </div>
  );
}
