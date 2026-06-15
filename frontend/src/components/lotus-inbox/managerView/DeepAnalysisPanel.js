import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, ApiError } from '../../../lib/api';

export default function DeepAnalysisPanel({ lotusId, summaryMd, summaryGeneratedAt, onRefresh }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const generate = async (force = false) => {
    setLoading(true); setErr('');
    try {
      const d = await api(`/api/lotus-inbox/contacts/${lotusId}/analyst-report`, {
        method: 'POST',
        body: { tier: 'B', force },
      });
      onRefresh && onRefresh(d);
    } catch (e) {
      const code = e instanceof ApiError ? e.body?.code : undefined;
      const data = e instanceof ApiError ? e.body : null;
      setErr(code === 'INBOUND_TOO_LOW_FOR_TIER_B'
        ? `Inbound terlalu sedikit (${data?.inbound_count}/5). Tier B butuh ≥5 inbound.`
        : code === 'TIER_A_MISSING'
        ? 'Tier A belum ada. Reload halaman dulu.'
        : `Error: ${data?.message || e.message}`);
    } finally { setLoading(false); }
  };

  return (
    <div className="bg-white border rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-gray-700">Deep Analysis (Tier B)</div>
        {summaryMd && (
          <button onClick={() => generate(true)} disabled={loading}
            className="text-xs px-2 py-1 border rounded hover:bg-gray-50 disabled:opacity-50">
            {loading ? 'Generating…' : '🔄 Regenerate'}
          </button>
        )}
      </div>

      {!summaryMd && !loading && (
        <div className="text-center py-6">
          <div className="text-sm text-gray-500 mb-2">Belum dijalankan.</div>
          <div className="text-xs text-gray-400 mb-3">(~5-10 detik, biaya ~Rp 200 per lead)</div>
          <button onClick={() => generate(false)}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded">
            🔍 Generate Deep Analysis
          </button>
        </div>
      )}

      {loading && <div className="text-sm text-gray-500 py-4">Analyzing… (~5-10 detik)</div>}
      {err && <div className="text-sm text-red-600 py-2">{err}</div>}

      {summaryMd && !loading && (
        <>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{summaryMd}</ReactMarkdown>
          </div>
          {summaryGeneratedAt && (
            <div className="text-[10px] text-gray-400 mt-3 border-t pt-2">
              Generated {new Date(summaryGeneratedAt).toLocaleString('id-ID')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
