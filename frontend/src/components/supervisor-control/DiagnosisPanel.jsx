// frontend/src/components/supervisor-control/DiagnosisPanel.jsx
import { useState } from 'react';
import { api } from '@/lib/api';

const ROOT_CAUSES = [
  'harga_terlalu_mahal','barang_tidak_tersedia','respon_lambat','info_produk_kurang',
  'ekspektasi_design','area_pengiriman','timing_pengiriman','kompetitor',
  'ragu_kredibilitas','window_shopping','sudah_closing','bukan_lead','lainnya',
];

export default function DiagnosisPanel({ lotusId, onAction }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [revising, setRevising] = useState(false);
  const [rev, setRev] = useState({ corrected_root_cause: '', corrected_reason: '', final_status: '', note: '' });

  async function generate() {
    setLoading(true); setError(null);
    try {
      const data = await api(`/api/lotus-inbox/contacts/${lotusId}/analyst-report`, {
        method: 'POST', body: JSON.stringify({ tier: 'A' }),
      });
      setReport(data);
    } catch (e) { setError(e.message || 'Gagal generate'); }
    finally { setLoading(false); }
  }

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-3 text-sm">
      {!report && !loading && (
        <button onClick={generate} className="px-3 py-1.5 rounded bg-sky-600 text-white text-xs font-medium">
          Generate AI Diagnosis
        </button>
      )}
      {loading && <div className="text-slate-500">Menganalisa percakapan…</div>}
      {error && <div className="text-rose-600">{error}</div>}

      {report && (
        <div className="space-y-2">
          <Field label="Status Lead" value={report.lead_status} />
          <Field label="Intent" value={report.customer_intent} />
          <Field label="Root Issue" value={report.root_cause_tag || report.funnel_stage_lost} />
          <Field label="Controllability" value={report.controllability} />
          {report.evidence_quote && <Field label="Bukti" value={`"${report.evidence_quote}"`} />}
          {report.analyst_summary_md && <Field label="Ringkasan" value={report.analyst_summary_md} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <ActBtn onClick={() => onAction('ack', { note: 'analisa sesuai' })} cls="bg-emerald-600">Ack</ActBtn>
        <ActBtn onClick={() => onAction('resolve', { note: 'sudah ditindaklanjuti' })} cls="bg-slate-700">Resolve</ActBtn>
        <ActBtn onClick={() => onAction('request_fu', {})} cls="bg-amber-600">Minta FU</ActBtn>
        <ActBtn onClick={() => setRevising((v) => !v)} cls="bg-violet-600">Revisi Analisa AI</ActBtn>
      </div>

      {revising && (
        <div className="border border-violet-200 rounded p-3 space-y-2 bg-white">
          <select className="w-full border rounded px-2 py-1 text-xs"
            value={rev.corrected_root_cause}
            onChange={(e) => setRev({ ...rev, corrected_root_cause: e.target.value })}>
            <option value="">— Kategori issue yang benar —</option>
            {ROOT_CAUSES.map((rc) => <option key={rc} value={rc}>{rc}</option>)}
          </select>
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Alasan sebenarnya"
            value={rev.corrected_reason} onChange={(e) => setRev({ ...rev, corrected_reason: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Catatan untuk sales"
            value={rev.note} onChange={(e) => setRev({ ...rev, note: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Status akhir (mis. lost / recovered)"
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
  return (
    <div>
      <div className="text-[11px] uppercase text-slate-400 font-medium">{label}</div>
      <div className="text-slate-700 whitespace-pre-wrap">{String(value)}</div>
    </div>
  );
}
function ActBtn({ onClick, cls, children }) {
  return <button onClick={onClick} className={`px-2.5 py-1 rounded text-white text-xs ${cls}`}>{children}</button>;
}
