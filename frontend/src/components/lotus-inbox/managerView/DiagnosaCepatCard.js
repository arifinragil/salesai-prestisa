import React from 'react';
import { labelOf, INTERNAL_RC_LABEL } from './enumLabels';

export default function DiagnosaCepatCard({ structured }) {
  if (!structured) return null;
  const s = structured;
  const Row = ({ label, value }) => (
    <div className="flex gap-2 py-1 border-b border-gray-50 last:border-0">
      <div className="text-xs text-gray-500 w-44 flex-shrink-0">{label}</div>
      <div className="text-sm text-gray-800">{value}</div>
    </div>
  );
  return (
    <div className="bg-white border rounded p-4">
      <div className="text-sm font-semibold text-gray-700 mb-3">Diagnosa Cepat (Tier A)</div>
      <Row label="Lead Status"          value={labelOf('lead_status', s.lead_status)} />
      <Row label="Funnel Stage Lost"    value={labelOf('funnel_stage_lost', s.funnel_stage_lost)} />
      <Row label="Customer Intent"      value={labelOf('customer_intent', s.customer_intent)} />
      <Row label="No Response After"    value={s.no_response_after ? labelOf('no_response_after', s.no_response_after) : '—'} />
      <Row label="Controllability"      value={labelOf('controllability', s.controllability)} />
      <Row label="Confidence"           value={labelOf('confidence', s.confidence)} />
      <Row label="Customer Reason"      value={labelOf('customer_reason', s.customer_reason)} />
      <Row label="Internal Root Cause"  value={
        <div className="flex flex-wrap gap-1">
          {(s.internal_root_cause_categories || []).map(c => (
            <span key={c} className="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded" title={INTERNAL_RC_LABEL[c] || c}>
              {c} — {INTERNAL_RC_LABEL[c] || c}
            </span>
          ))}
          {(s.internal_root_cause_categories || []).length === 0 && <span className="text-gray-400">—</span>}
        </div>
      } />
      <Row label="Decision Maker"       value={labelOf('decision_maker', s.decision_maker)} />
      {s.evidence_quote && (
        <Row label="Bukti dari chat" value={<em className="text-gray-600">"{s.evidence_quote}"</em>} />
      )}
    </div>
  );
}
