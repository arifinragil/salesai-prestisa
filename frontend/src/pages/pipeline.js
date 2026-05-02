import { useEffect, useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import PipelineBoard from '@/components/PipelineBoard';
import PipelineMobile from '@/components/PipelineMobile';
import PipelineForecastPanel from '@/components/PipelineForecastPanel';
import { fetcher } from '@/lib/api';

const TYPES = ['', 'papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b', 'unknown'];

function useViewport() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    function onResize() { setW(window.innerWidth); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

export default function PipelinePage() {
  const [type, setType] = useState('');
  const [claimedBy, setClaimedBy] = useState('');
  const [forecastOpen, setForecastOpen] = useState(false);
  const w = useViewport();
  const isMobile = w < 768;
  const collapseClosed = w >= 768 && w < 1024;

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (claimedBy) params.set('claimed_by', claimedBy);
  const url = `/api/pipeline/board${params.toString() ? '?' + params.toString() : ''}`;

  const { data, mutate } = useSWR(url, fetcher, { refreshInterval: 30_000 });

  return (
    <Layout title="Pipeline — Tiara">
      <div className="px-3 sm:px-6 py-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-slate-800">Pipeline</h1>
          <select value={type} onChange={(e) => setType(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            {TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
          </select>
          <select value={claimedBy} onChange={(e) => setClaimedBy(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            <option value="">All operators</option>
            <option value="me">Me only</option>
          </select>
          <button onClick={() => setForecastOpen(true)}
            className="ml-auto text-xs px-3 py-1.5 rounded bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100">
            📊 Forecast
          </button>
        </div>

        {isMobile
          ? <PipelineMobile data={data} mutate={mutate} />
          : <PipelineBoard data={data} mutate={mutate} collapseClosed={collapseClosed} />}
      </div>

      <PipelineForecastPanel open={forecastOpen} onClose={() => setForecastOpen(false)} type={type} />
    </Layout>
  );
}
