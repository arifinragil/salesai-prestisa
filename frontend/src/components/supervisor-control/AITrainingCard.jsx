import { useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';

const CATS = [
  { v: 'customer', label: 'Customer' },
  { v: 'sales_handling', label: 'Sales Handling' },
  { v: 'offer', label: 'Offer' },
  { v: 'process', label: 'Process' },
];

const CAT_COLORS = {
  customer: 'bg-sky-100 text-sky-700',
  sales_handling: 'bg-violet-100 text-violet-700',
  offer: 'bg-emerald-100 text-emerald-700',
  process: 'bg-amber-100 text-amber-700',
};

function StatBox({ label, value, color = 'text-slate-800' }) {
  return (
    <div className="flex flex-col items-center px-4 py-2 bg-slate-50 rounded-lg border border-slate-100">
      <span className={`text-2xl font-bold ${color}`}>{value ?? '—'}</span>
      <span className="text-[11px] text-slate-500 mt-0.5 text-center">{label}</span>
    </div>
  );
}

function AddForm({ onSaved, onCancel }) {
  const [form, setForm] = useState({
    case_pattern: '',
    category: '',
    subtype: '',
    analysis: '',
    suggested_action: '',
    suggested_script: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    if (!form.case_pattern.trim() || !form.category || !form.analysis.trim()) {
      setErr('Case pattern, kategori, dan analisa wajib diisi.');
      return;
    }
    setBusy(true); setErr('');
    try {
      await api('/api/supervisor-control/training-examples', {
        method: 'POST',
        body: {
          case_pattern: form.case_pattern.trim(),
          category: form.category,
          subtype: form.subtype.trim() || null,
          analysis: form.analysis.trim(),
          suggested_action: form.suggested_action.trim() || null,
          suggested_script: form.suggested_script.trim() || null,
        },
      });
      onSaved();
    } catch (e2) {
      setErr(e2.message || 'Gagal simpan.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border border-slate-200 rounded-lg p-4 space-y-3 bg-white mt-3">
      <p className="text-sm font-semibold text-slate-700">+ Tambah Training Example</p>
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Case Pattern <span className="text-rose-500">*</span></label>
        <input
          value={form.case_pattern}
          onChange={(e) => set('case_pattern', e.target.value)}
          placeholder="Contoh: Customer tanya harga tapi tidak menyebutkan budget"
          className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Kategori <span className="text-rose-500">*</span></label>
          <select
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
          >
            <option value="">— Pilih —</option>
            {CATS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 mb-1 block">Subtype</label>
          <input
            value={form.subtype}
            onChange={(e) => set('subtype', e.target.value)}
            placeholder="opsional"
            className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Analisa <span className="text-rose-500">*</span></label>
        <textarea
          value={form.analysis}
          onChange={(e) => set('analysis', e.target.value)}
          rows={2}
          placeholder="Penjelasan pola dan konteks yang relevan"
          className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
        />
      </div>
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Suggested Action</label>
        <input
          value={form.suggested_action}
          onChange={(e) => set('suggested_action', e.target.value)}
          placeholder="Opsional — langkah yang direkomendasikan"
          className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
        />
      </div>
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Suggested Script</label>
        <textarea
          value={form.suggested_script}
          onChange={(e) => set('suggested_script', e.target.value)}
          rows={2}
          placeholder="Opsional — contoh kalimat/script"
          className="w-full text-sm border border-slate-200 rounded-md px-3 py-2"
        />
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="text-sm px-4 py-2 rounded-md bg-violet-600 text-white disabled:opacity-50"
        >
          {busy ? '…' : '✓ Simpan'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-slate-500">Batal</button>
      </div>
    </form>
  );
}

function EditForm({ item, onSaved, onCancel }) {
  const [form, setForm] = useState({
    case_pattern: item.case_pattern || '',
    category: item.category || '',
    subtype: item.subtype || '',
    analysis: item.analysis || '',
    suggested_action: item.suggested_action || '',
    suggested_script: item.suggested_script || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function submit(e) {
    e.preventDefault();
    if (!form.case_pattern.trim() || !form.category || !form.analysis.trim()) {
      setErr('Case pattern, kategori, dan analisa wajib diisi.'); return;
    }
    setBusy(true); setErr('');
    try {
      await api(`/api/supervisor-control/training-examples/${item.id}`, {
        method: 'PUT',
        body: {
          case_pattern: form.case_pattern.trim(),
          category: form.category,
          subtype: form.subtype.trim() || null,
          analysis: form.analysis.trim(),
          suggested_action: form.suggested_action.trim() || null,
          suggested_script: form.suggested_script.trim() || null,
        },
      });
      onSaved();
    } catch (e2) {
      setErr(e2.message || 'Gagal update.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border border-violet-200 rounded-lg p-3 space-y-2 bg-violet-50/30 mt-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          value={form.case_pattern}
          onChange={(e) => set('case_pattern', e.target.value)}
          placeholder="Case Pattern *"
          className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
        />
        <select
          value={form.category}
          onChange={(e) => set('category', e.target.value)}
          className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
        >
          <option value="">— Kategori —</option>
          {CATS.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
        </select>
        <input
          value={form.subtype}
          onChange={(e) => set('subtype', e.target.value)}
          placeholder="Subtype"
          className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
        />
        <input
          value={form.suggested_action}
          onChange={(e) => set('suggested_action', e.target.value)}
          placeholder="Suggested Action"
          className="text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
        />
      </div>
      <textarea
        value={form.analysis}
        onChange={(e) => set('analysis', e.target.value)}
        rows={2}
        placeholder="Analisa *"
        className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
      />
      <textarea
        value={form.suggested_script}
        onChange={(e) => set('suggested_script', e.target.value)}
        rows={2}
        placeholder="Suggested Script"
        className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white"
      />
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white disabled:opacity-50">
          {busy ? '…' : '✓ Update'}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-slate-500">Batal</button>
      </div>
    </form>
  );
}

export default function AITrainingCard() {
  const [open, setOpen] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [disablingId, setDisablingId] = useState(null);

  const { data, mutate, error } = useSWR(
    '/api/supervisor-control/training-examples?active=true',
    fetcher
  );

  const items = data?.items || [];
  const stats = data?.stats || {};

  async function handleDisable(id) {
    setDisablingId(id);
    try {
      await api(`/api/supervisor-control/training-examples/${id}`, { method: 'DELETE' });
      mutate();
    } catch {
      // silently ignore, user can retry
    } finally {
      setDisablingId(null);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 sm:px-5 py-4 flex items-start sm:items-center justify-between gap-3 text-left hover:bg-slate-50 transition-colors"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base">🧠</span>
            <h2 className="text-sm font-semibold text-slate-800">
              AI Training Examples — Self-improving Knowledge Base
            </h2>
          </div>
          {data && (
            <p className="text-xs text-slate-500 mt-0.5 pl-6">
              {stats.active_count ?? 0} aktif ·{' '}
              {stats.from_revise ?? 0} dari revise ·{' '}
              {stats.from_manual ?? 0} manual ·{' '}
              {stats.total_usage ?? 0}× total usage
            </p>
          )}
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {/* Stats row */}
          {data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-4 sm:px-5 py-4">
              <StatBox label="Active" value={stats.active_count} color="text-violet-700" />
              <StatBox label="Auto dari Revise" value={stats.from_revise} color="text-sky-700" />
              <StatBox label="Manual" value={stats.from_manual} color="text-emerald-700" />
              <StatBox label="Total Usage" value={stats.total_usage} color="text-amber-700" />
            </div>
          )}

          {/* Add button */}
          <div className="px-4 sm:px-5 pb-3 flex items-center gap-3">
            <button
              onClick={() => { setShowAdd((v) => !v); setEditingId(null); }}
              className="text-sm px-3 py-2 rounded-md bg-violet-600 text-white inline-flex items-center gap-1"
            >
              + Tambah Manual
            </button>
            {error && <span className="text-xs text-rose-500">Gagal memuat data.</span>}
            {!data && !error && <span className="text-xs text-slate-400">Memuat…</span>}
          </div>

          {showAdd && (
            <div className="px-4 sm:px-5 pb-4">
              <AddForm
                onSaved={() => { mutate(); setShowAdd(false); }}
                onCancel={() => setShowAdd(false)}
              />
            </div>
          )}

          {/* Items list */}
          {items.length === 0 && !showAdd && (
            <p className="text-xs text-slate-400 px-4 sm:px-5 pb-4">Belum ada training example aktif.</p>
          )}
          <div className="divide-y divide-slate-100">
            {items.map((item) => (
              <div key={item.id} className="px-4 sm:px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{item.case_pattern}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CAT_COLORS[item.category] || 'bg-slate-100 text-slate-600'}`}>
                        {item.category}
                      </span>
                      {item.subtype && (
                        <span className="text-xs text-slate-500">{item.subtype}</span>
                      )}
                      <span className="text-xs text-slate-400">
                        Used {item.usage_count ?? 0}×
                      </span>
                      {item.created_by_name && (
                        <span className="text-xs text-slate-400">oleh {item.created_by_name}</span>
                      )}
                    </div>
                    {item.analysis && (
                      <p className="text-xs text-slate-600 mt-1 line-clamp-2">{item.analysis}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setEditingId(editingId === item.id ? null : item.id)}
                      className="text-xs px-2.5 py-1.5 rounded border border-violet-200 text-violet-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDisable(item.id)}
                      disabled={disablingId === item.id}
                      className="text-xs px-2.5 py-1.5 rounded border border-rose-200 text-rose-600 disabled:opacity-50"
                    >
                      {disablingId === item.id ? '…' : 'Disable'}
                    </button>
                  </div>
                </div>
                {editingId === item.id && (
                  <EditForm
                    item={item}
                    onSaved={() => { mutate(); setEditingId(null); }}
                    onCancel={() => setEditingId(null)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
