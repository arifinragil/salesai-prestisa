// frontend/src/pages/supervisor-control/index.js
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import TabStrip from '@/components/lotus-inbox/TabStrip';
import DiagnosisPanel from '@/components/supervisor-control/DiagnosisPanel';

export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';
  const [tab, setTab] = useState('urgent');
  const [openId, setOpenId] = useState(null);
  const [hidden, setHidden] = useState({});

  const listUrl = isAdmin ? `/api/lotus-inbox/contacts?tab=${tab}&limit=100` : null;
  const list = useSWR(listUrl, fetcher, { refreshInterval: 60_000 });
  const counts = useSWR(isAdmin ? '/api/lotus-inbox/tab-counts' : null, fetcher, { refreshInterval: 60_000 });

  async function handleAction(lotusId, action, payload) {
    await api(`/api/supervisor-control/lead/${lotusId}/action`, {
      method: 'POST', body: { action, ...payload },
    });
    if (action === 'ack' || action === 'resolve') setHidden((h) => ({ ...h, [lotusId]: true }));
  }

  if (me.data && !isAdmin) {
    return <Layout title="Supervisor Control — Tiara">
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">Halaman ini hanya untuk admin.</div>
    </Layout>;
  }

  const items = (list.data?.items || []).filter((it) => !hidden[it.lotus_id]);

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <h1 className="text-lg font-semibold text-slate-800">Supervisor Control — Review Lead</h1>
        <TabStrip tab={tab} counts={counts.data?.counts || {}} onChange={(t) => { setTab(t); setOpenId(null); }} />
        {list.error && <div className="text-sm text-rose-600">Gagal memuat: {list.error.message}</div>}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {items.length === 0 && !list.isLoading && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">Tidak ada lead di tab ini 🎉</div>
          )}
          {items.map((it) => (
            <div key={it.lotus_id} className="border-b border-slate-100">
              <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800 truncate">{it.cust_name || '(tanpa nama)'}
                    {it.lotus_assign_to && <span className="ml-2 text-xs text-slate-400">PIC: {it.lotus_assign_to}</span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{it.last_message_from === 'inbound' ? '⬅︎ ' : '➡︎ '}{it.last_body || ''}</div>
                </div>
                <a href={`/lotus-inbox/${it.lotus_id}`} className="px-2 py-1 rounded bg-sky-600 text-white text-xs">Chat</a>
                <button onClick={() => setOpenId(openId === it.lotus_id ? null : it.lotus_id)}
                  className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-xs">{openId === it.lotus_id ? '▴' : '▾ Diagnosa'}</button>
              </div>
              {openId === it.lotus_id && (
                <DiagnosisPanel lotusId={it.lotus_id} onAction={(a, p) => handleAction(it.lotus_id, a, p)} />
              )}
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-400">Reuse antrian Kanban · update tiap 60 detik · {items.length} lead</div>
      </div>
    </Layout>
  );
}
