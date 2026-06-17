// frontend/src/pages/supervisor-control/index.js
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import PriorityQueue from '@/components/supervisor-control/PriorityQueue';
import GroupSection from '@/components/supervisor-control/GroupSection';

export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';
  const [scope, setScope] = useState('team');
  const [hidden, setHidden] = useState({});
  const url = isAdmin ? `/api/supervisor-control/panel${scope === 'mine' ? '?scope=mine' : ''}` : null;
  const panel = useSWR(url, fetcher, { refreshInterval: 60_000 });

  async function onAction(lotusId, action, payload) {
    await api(`/api/supervisor-control/lead/${lotusId}/action`, { method: 'POST', body: { action, ...payload } });
    if (action === 'ack' || action === 'resolve') setHidden((h) => ({ ...h, [lotusId]: true }));
    else panel.mutate();
  }
  const visible = (arr) => (arr || []).filter((i) => !hidden[i.lotus_id]);

  if (me.data && !isAdmin) return <Layout title="Supervisor Control — Tiara"><div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">Halaman ini hanya untuk admin.</div></Layout>;

  const d = panel.data || {};
  const g = d.groups || {};
  const buckets = g.lead_stuck ? Object.fromEntries(Object.entries(g.lead_stuck).map(([k, v]) => [k, visible(v)])) : { A: [], B: [], C: [], D: [] };
  const gc = d.counts?.groups || {};
  const leadStuckTotal = gc.lead_stuck ? Object.values(gc.lead_stuck).reduce((s, n) => s + (n || 0), 0) : undefined;

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor Control Panel</h1>
          <div className="flex gap-1.5">
            <button onClick={() => setScope('team')} className={`px-2 py-1 rounded text-xs ${scope === 'team' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Tim</button>
            <button onClick={() => setScope('mine')} className={`px-2 py-1 rounded text-xs ${scope === 'mine' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Saya</button>
            <button onClick={() => panel.mutate()} className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-xs">↻</button>
          </div>
        </div>
        {panel.error && <div className="text-sm text-rose-600">Gagal memuat: {panel.error.message}</div>}

        <PriorityQueue items={visible(d.priority_queue)} counts={d.counts || {}} onAction={onAction} />
        <GroupSection title="Sales Response Risk" icon="⚡" items={visible(g.sales_response_risk)} total={gc.sales_response_risk} onAction={onAction} />
        <GroupSection title="Follow Up Customer" icon="🔁" items={visible(g.follow_up)} total={gc.follow_up} onAction={onAction}
          extra={(i) => `cycle FU ${i.fu_current_cycle}/3 · ${i.fu_count_today} FU hari ini${i.fu_status === 'overdue' ? ' · overdue' : ''}`} />
        <GroupSection title="Lead Stuck / Belum Closing" icon="🧩" buckets={buckets} total={leadStuckTotal} onAction={onAction} />
        <div className="text-xs text-slate-400">Update tiap 60 detik · {d.counts?.total || 0} lead aktif</div>
      </div>
    </Layout>
  );
}
