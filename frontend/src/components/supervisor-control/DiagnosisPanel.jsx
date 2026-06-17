// frontend/src/components/supervisor-control/DiagnosisPanel.jsx
import { useState } from 'react';
import { api } from '@/lib/api';

const ROOT_CAUSES = ['harga_terlalu_mahal','barang_tidak_tersedia','respon_lambat','info_produk_kurang',
  'ekspektasi_design','area_pengiriman','timing_pengiriman','kompetitor','ragu_kredibilitas',
  'window_shopping','sudah_closing','bukan_lead','lainnya'];

const HANDLING_LABEL = { discovery: 'Gali kebutuhan', recommendation: 'Rekomendasi produk',
  quotation_quality: 'Kualitas penawaran', objection_handling: 'Tangani keberatan', cta: 'Call-to-action', follow_up: 'Follow up' };

export default function DiagnosisPanel({ lead, onAction }) {
  const [tierB, setTierB] = useState(null);
  const [loadingB, setLoadingB] = useState(false);
  const [error, setError] = useState(null);
  const [revising, setRevising] = useState(false);
  const [rev, setRev] = useState({ corrected_root_cause: '', corrected_reason: '', final_status: '', note: '' });

  const gaps = lead.sales_handling && typeof lead.sales_handling === 'object'
    ? Object.entries(lead.sales_handling).filter(([, v]) => v === false).map(([k]) => HANDLING_LABEL[k] || k) : [];

  async function loadAction() {
    setLoadingB(true); setError(null);
    try {
      const d = await api(`/api/lotus-inbox/contacts/${lead.lotus_id}/analyst-report`, { method: 'POST', body: { tier: 'B' } });
      setTierB(d.analyst_summary_md || d.summary || 'Tidak ada ringkasan.');
    } catch (e) { setError(e.message || 'Gagal'); } finally { setLoadingB(false); }
  }

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-2 text-sm">
      <Field label="AI Diagnosis" value={lead.lead_status || lead.customer_intent} />
      <Field label="Root Issue" value={lead.stuck_label || lead.root_cause_tag || lead.funnel_stage_lost} />
      {gaps.length > 0 && <Field label="Gap Sales Handling" value={gaps.join(' · ')} />}
      <Field label="Controllability" value={lead.controllability} />
      {lead.evidence_quote && <Field label="Bukti" value={`"${lead.evidence_quote}"`} />}

      <div>
        <div className="text-[11px] uppercase text-slate-400 font-medium">Suggested Action / Script</div>
        {!tierB && !loadingB && <button onClick={loadAction} className="mt-1 px-2.5 py-1 rounded bg-sky-600 text-white text-xs">Tampilkan saran AI</button>}
        {loadingB && <div className="text-slate-500">Memuat…</div>}
        {error && <div className="text-rose-600">{error}</div>}
        {tierB && <div className="text-slate-700 whitespace-pre-wrap mt-1">{tierB}</div>}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <ActBtn onClick={() => onAction('ack', { note: 'analisa sesuai' })} cls="bg-emerald-600">Ack</ActBtn>
        <ActBtn onClick={() => onAction('resolve', { note: 'sudah ditindaklanjuti' })} cls="bg-slate-700">Resolve</ActBtn>
        <ActBtn onClick={() => onAction('request_fu', {})} cls="bg-amber-600">Minta FU</ActBtn>
        <ActBtn onClick={() => setRevising((v) => !v)} cls="bg-violet-600">Revisi Analisa AI</ActBtn>
      </div>

      {revising && (
        <div className="border border-violet-200 rounded p-3 space-y-2 bg-white">
          <select className="w-full border rounded px-2 py-1 text-xs" value={rev.corrected_root_cause}
            onChange={(e) => setRev({ ...rev, corrected_root_cause: e.target.value })}>
            <option value="">— Kategori issue yang benar —</option>
            {ROOT_CAUSES.map((rc) => <option key={rc} value={rc}>{rc}</option>)}
          </select>
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Alasan sebenarnya"
            value={rev.corrected_reason} onChange={(e) => setRev({ ...rev, corrected_reason: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Catatan untuk sales"
            value={rev.note} onChange={(e) => setRev({ ...rev, note: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Status akhir"
            value={rev.final_status} onChange={(e) => setRev({ ...rev, final_status: e.target.value })} />
          <button className="px-3 py-1.5 rounded bg-violet-600 text-white text-xs"
            onClick={() => { onAction('revise_ai', rev); setRevising(false); }}>Simpan Revisi</button>
        </div>
      )}
    </div>
  );
}
function Field({ label, value }) {
  if (!value) return null;
  return (<div><div className="text-[11px] uppercase text-slate-400 font-medium">{label}</div><div className="text-slate-700 whitespace-pre-wrap">{String(value)}</div></div>);
}
function ActBtn({ onClick, cls, children }) { return <button onClick={onClick} className={`px-2.5 py-1 rounded text-white text-xs ${cls}`}>{children}</button>; }
