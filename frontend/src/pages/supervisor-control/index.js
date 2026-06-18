// frontend/src/pages/supervisor-control/index.js
import { useState, useRef } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import PrioritySummary from '@/components/supervisor-control/PrioritySummary';
import SubSection from '@/components/supervisor-control/SubSection';
import LeadRow from '@/components/supervisor-control/LeadRow';
import ReviewForm from '@/components/supervisor-control/ReviewForm';
import DiagnosisPanel from '@/components/supervisor-control/DiagnosisPanel';
import CycleSplit from '@/components/supervisor-control/CycleSplit';
import AITrainingCard from '@/components/supervisor-control/AITrainingCard';
import ActionTrackerCard from '@/components/supervisor-control/ActionTrackerCard';
import DailyRecapCard from '@/components/supervisor-control/DailyRecapCard';

// ─── inline GroupCard ───────────────────────────────────────────────────────
function GroupCard({ id, title, count, priorityChip, forceOpen, children }) {
  const [open, setOpen] = useState(true);
  // forceOpen signal: when it changes to true, re-open
  const prevForce = useRef(false);
  if (forceOpen && !prevForce.current) {
    prevForce.current = true;
    // schedule open in next tick if currently closed
    if (!open) setTimeout(() => setOpen(true), 0);
  }
  if (!forceOpen) prevForce.current = false;

  return (
    <div id={id} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 sm:px-5 py-3 flex items-center justify-between gap-2 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
          {count != null && (
            <span className="text-xs font-bold text-white bg-rose-500 rounded-full px-2 py-0.5 shrink-0">
              {count}
            </span>
          )}
          {priorityChip && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">
              {priorityChip}
            </span>
          )}
        </div>
        <span className="text-slate-400 text-sm shrink-0">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="border-t border-slate-100">{children}</div>}
    </div>
  );
}

// ─── bucket label map ───────────────────────────────────────────────────────
const BUCKET_LABELS = {
  A: 'A · Issue dari Customer',
  B: 'B · Issue dari Sales Handling',
  C: 'C · Issue dari Offer / Produk',
  D: 'D · Issue dari Proses',
  uncategorized: 'Belum Dikategorikan',
};

// ─── main page ──────────────────────────────────────────────────────────────
export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';

  const [scope, setScope] = useState('team');
  // forceOpen: keyed by group id string, boolean
  const [forceOpen, setForceOpen] = useState({});
  // reviewing: lotus_id currently open in ReviewForm
  const [reviewing, setReviewing] = useState(null);
  // diagnosing: lead object currently open in DiagnosisPanel
  const [diagnosing, setDiagnosing] = useState(null);
  // bulk diagnose loading state
  const [bulkLoading, setBulkLoading] = useState(false);

  const url = isAdmin
    ? `/api/supervisor-control/panel?scope=${scope === 'mine' ? 'mine' : 'team'}`
    : null;
  const { data, mutate, error } = useSWR(url, fetcher, { refreshInterval: 60_000 });

  function onJump(code) {
    const idMap = { P1: 'grp-1', P2: 'grp-2', P3: 'grp-3' };
    const targetId = idMap[code];
    if (!targetId) return;
    setForceOpen((prev) => ({ ...prev, [targetId]: true }));
    setTimeout(() => {
      const el = document.getElementById(targetId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // reset forceOpen after scroll so it can re-trigger next time
      setForceOpen((prev) => ({ ...prev, [targetId]: false }));
    }, 80);
  }

  async function handleBulkDiagnose(lotusIds) {
    if (!lotusIds.length) return;
    setBulkLoading(true);
    try {
      await api('/api/supervisor-control/bulk-diagnose', { method: 'POST', body: { lotus_ids: lotusIds } });
      mutate();
    } catch (e) {
      console.error('Bulk diagnose failed', e);
    } finally {
      setBulkLoading(false);
    }
  }

  // Admin gate
  if (me.data && !isAdmin) {
    return (
      <Layout title="Supervisor Control — Tiara">
        <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">
          Halaman ini hanya untuk admin.
        </div>
      </Layout>
    );
  }

  const d = data || {};
  const responseRisk = d.responseRisk || { customerWaiting: [], slowFirstResponse: [], salesPromiseBroken: [] };
  const followUp = d.followUp || { customerGhost: [], bubbleChat: [], pendingFuByCycle: { 1: [], 2: [], 3: [] } };
  const leadStuck = d.leadStuckByCategory || { A: [], B: [], C: [], D: [], uncategorized: [] };

  const grp1Count = responseRisk.customerWaiting.length + responseRisk.slowFirstResponse.length + responseRisk.salesPromiseBroken.length;
  const grp2Count = followUp.customerGhost.length + followUp.bubbleChat.length +
    Object.values(followUp.pendingFuByCycle || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
  const grp3Count = Object.values(leadStuck).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        {/* Scope toggle + refresh */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor Control Panel</h1>
          <div className="flex gap-1.5">
            <button onClick={() => setScope('team')} className={`px-2 py-1 rounded text-xs ${scope === 'team' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Tim</button>
            <button onClick={() => setScope('mine')} className={`px-2 py-1 rounded text-xs ${scope === 'mine' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Saya</button>
            <button onClick={() => mutate()} className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-xs">↻</button>
          </div>
        </div>

        {error && <div className="text-sm text-rose-600">Gagal memuat: {error.message}</div>}

        {/* 1. Priority Summary bar */}
        <PrioritySummary priority={d.priority} onJump={onJump} />

        {/* 2. Sales Response Risk */}
        <GroupCard id="grp-1" title="1. Sales Response Risk" count={grp1Count} priorityChip="P1" forceOpen={forceOpen['grp-1']}>
          <SubSection icon="⏰" title="Customer Menunggu Balas" count={responseRisk.customerWaiting.length}
            situation="Customer kirim pesan, sales belum balas > 10 menit."
            actionHint="Chat langsung atau salin remind ke sales.">
            {responseRisk.customerWaiting.length === 0
              ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
              : responseRisk.customerWaiting.map((lead) => (
                <LeadRow key={lead.lotus_id} lead={lead} variant="waiting" />
              ))}
          </SubSection>

          <SubSection icon="🚨" title="Slow First Response" count={responseRisk.slowFirstResponse.length}
            situation="Sales belum balas lead baru dalam 10 menit pertama."
            actionHint="Segera balas atau assign ke sales yang available.">
            {responseRisk.slowFirstResponse.length === 0
              ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
              : responseRisk.slowFirstResponse.map((lead) => (
                <LeadRow key={lead.lotus_id} lead={lead} variant="waiting" />
              ))}
          </SubSection>

          <SubSection icon="🤝" title="Sales Janji Belum Balik" count={responseRisk.salesPromiseBroken.length}
            situation="Sales berjanji follow up tapi belum ada kabar."
            actionHint="Konfirmasi ke sales atau ambil alih chat.">
            {responseRisk.salesPromiseBroken.length === 0
              ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
              : responseRisk.salesPromiseBroken.map((lead) => (
                <LeadRow key={lead.lotus_id} lead={lead} variant="promise" />
              ))}
          </SubSection>
        </GroupCard>

        {/* 3. Follow Up Customer */}
        <GroupCard id="grp-2" title="2. Follow Up Customer" count={grp2Count} priorityChip="P2" forceOpen={forceOpen['grp-2']}>
          <SubSection icon="👻" title="Customer Belum Balas Sales" count={followUp.customerGhost.length}
            situation="Sales sudah follow up tapi customer belum balas."
            actionHint="Cek last message, pertimbangkan FU lagi atau parkir.">
            {followUp.customerGhost.length === 0
              ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
              : followUp.customerGhost.map((lead) => (
                <LeadRow key={lead.lotus_id} lead={lead} variant="ghost" />
              ))}
          </SubSection>

          <SubSection icon="💬" title="Bubble Chat 1×" count={followUp.bubbleChat.length}
            situation="Customer balas 1 pesan tapi belum ada kelanjutan."
            actionHint="Sambut dan dorong ke konversasi lebih dalam.">
            {followUp.bubbleChat.length === 0
              ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
              : followUp.bubbleChat.map((lead) => (
                <LeadRow key={lead.lotus_id} lead={lead} variant="ghost" />
              ))}
          </SubSection>

          <SubSection icon="🔁" title="Follow Up Hari H" count={Object.values(followUp.pendingFuByCycle || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0)}
            situation="Lead yang jadwal FU-nya hari ini belum dikerjakan."
            actionHint="Prioritaskan sesuai cycle — cycle 1 paling urgent.">
            <CycleSplit cycles={followUp.pendingFuByCycle} />
          </SubSection>
        </GroupCard>

        {/* 4. Lead Stuck */}
        <GroupCard id="grp-3" title="3. Lead Stuck Belum Closing" count={grp3Count} priorityChip="P2" forceOpen={forceOpen['grp-3']}>
          {Object.entries(leadStuck).map(([bucket, leads]) => {
            const arr = Array.isArray(leads) ? leads : [];
            const isUncategorized = bucket === 'uncategorized';
            return (
              <SubSection
                key={bucket}
                icon={isUncategorized ? '❓' : bucket}
                title={BUCKET_LABELS[bucket] || bucket}
                count={arr.length}
                situation={isUncategorized ? 'Lead belum terdiagnosa oleh AI.' : undefined}
                actionHint={isUncategorized ? 'Bulk diagnose untuk kategorisasi otomatis.' : undefined}
              >
                {isUncategorized && arr.length > 0 && (
                  <div className="px-4 py-2">
                    <button
                      onClick={() => handleBulkDiagnose(arr.map((l) => l.lotus_id))}
                      disabled={bulkLoading}
                      className="text-xs px-3 py-1.5 rounded bg-violet-600 text-white disabled:opacity-50"
                    >
                      {bulkLoading ? 'Mendiagnosa…' : `Bulk Diagnose ${arr.length} Lead`}
                    </button>
                  </div>
                )}
                {arr.length === 0
                  ? <p className="px-4 py-3 text-xs text-slate-400">Tidak ada.</p>
                  : arr.map((lead) => (
                    <div key={lead.lotus_id}>
                      <LeadRow
                        lead={lead}
                        variant="stuck"
                        onReview={(l) => setReviewing(reviewing === l.lotus_id ? null : l.lotus_id)}
                        onReviewDx={(l) => setDiagnosing(diagnosing?.lotus_id === l.lotus_id ? null : l)}
                      />
                      {reviewing === lead.lotus_id && (
                        <ReviewForm
                          lead={lead}
                          onDone={() => { setReviewing(null); mutate(); }}
                          onCancel={() => setReviewing(null)}
                        />
                      )}
                      {diagnosing?.lotus_id === lead.lotus_id && (
                        <DiagnosisPanel
                          lead={diagnosing}
                          onAction={async (action, payload) => {
                            await api(`/api/supervisor-control/lead/${lead.lotus_id}/action`, { method: 'POST', body: { action, ...payload } });
                            setDiagnosing(null);
                            mutate();
                          }}
                        />
                      )}
                    </div>
                  ))}
              </SubSection>
            );
          })}
        </GroupCard>

        {/* 5–7. Cards */}
        <AITrainingCard />
        <ActionTrackerCard />
        <DailyRecapCard />

        <div className="text-xs text-slate-400">
          Update tiap 60 detik{d.generatedAt ? ` · ${new Date(d.generatedAt).toLocaleTimeString('id-ID')}` : ''}
        </div>
      </div>
    </Layout>
  );
}
