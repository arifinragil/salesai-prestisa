import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import DiagnosaCepatCard from './DiagnosaCepatCard';
import SalesHandlingGrid from './SalesHandlingGrid';
import ProductSolutionFitGrid from './ProductSolutionFitGrid';
import DeepAnalysisPanel from './DeepAnalysisPanel';

export default function ManagerViewTab({ lotusId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const fetchTierA = async (force = false) => {
    setLoading(true); setErr(null);
    try {
      const d = await api(`/api/lotus-inbox/contacts/${lotusId}/analyst-report`, {
        method: 'POST',
        body: { tier: 'A', force },
      });
      setData(d);
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.code : undefined;
      const body = e instanceof ApiError ? e.body : null;
      if (code === 'INBOUND_TOO_LOW') {
        setErr({ code, msg: `Data tidak cukup (${body.inbound_count} inbound). Tier A butuh ≥4 inbound untuk diagnostic bermakna.` });
      } else {
        setErr({ code, msg: body?.message || e.message });
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { if (lotusId) fetchTierA(false); /* eslint-disable-next-line */ }, [lotusId]);

  if (loading && !data) return <div className="p-4 text-sm text-gray-500">Loading… (~5-10 detik kalau cold cache)</div>;
  if (err) return (
    <div className="p-4">
      <div className="bg-yellow-50 border border-yellow-200 rounded p-4 text-sm text-gray-700">
        {err.msg}
      </div>
    </div>
  );
  if (!data) return null;

  const s = data.structured;
  return (
    <div className="p-4 space-y-3 max-w-3xl">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <div>Tier A: {data.message_count} pesan · {data.inbound_count} inbound · {data.source}</div>
        <button onClick={() => fetchTierA(true)} className="px-2 py-1 border rounded hover:bg-gray-50">
          🔄 Regenerate Tier A
        </button>
      </div>
      <DiagnosaCepatCard structured={s} />
      <SalesHandlingGrid sales_handling={s.sales_handling} />
      <ProductSolutionFitGrid product_solution_fit={s.product_solution_fit} />
      <DeepAnalysisPanel
        lotusId={lotusId}
        summaryMd={data.summary_md}
        summaryGeneratedAt={data.summary_generated_at}
        onRefresh={(d) => setData(prev => ({ ...prev, summary_md: d.summary_md, summary_generated_at: d.summary_generated_at }))}
      />
    </div>
  );
}
