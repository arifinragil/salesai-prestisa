import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState, useRef } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useNotifPermission, useNotificationSound, showBrowserNotification } from '@/lib/useNotifications';
import { formatRelative, truncate, convStatusLabel, formatPhone, formatDisplayName, isLidPhone } from '@/lib/format';
import PipelineStageBadge from '@/components/PipelineStageBadge';
import LeadTempBadge from '@/components/LeadTempBadge';

const TAG_COLOR = {
  slate:'bg-slate-100 text-slate-700 border-slate-200',
  rose:'bg-rose-100 text-rose-700 border-rose-200',
  amber:'bg-amber-100 text-amber-800 border-amber-200',
  emerald:'bg-emerald-100 text-emerald-700 border-emerald-200',
  sky:'bg-sky-100 text-sky-700 border-sky-200',
  indigo:'bg-indigo-100 text-indigo-700 border-indigo-200',
  violet:'bg-violet-100 text-violet-700 border-violet-200',
  pink:'bg-pink-100 text-pink-700 border-pink-200',
};

const STATUS_FILTERS = [
  { value: '',       label: 'Semua' },
  { value: 'active', label: 'Aktif' },
  { value: 'closed', label: 'Closed' },
  { value: 'spam',   label: 'Spam' },
];

export default function InboxList() {
  const router = useRouter();
  const [status, setStatus] = useState('');
  const [waSession, setWaSession] = useState('');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState('');
  const [tagId, setTagId] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [selected, setSelected] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const playSound = useNotificationSound();
  const notif = useNotifPermission();
  const seenConvIds = useRef(new Set());
  const firstLoadRef = useRef(true);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (waSession) params.set('wa_session', waSession);
  if (search) params.set('search', search);
  if (queue) params.set('queue', queue);
  if (tagId) params.set('tag_id', tagId);
  if (stageFilter) params.set('pipeline_stage', stageFilter);
  if (sortBy && sortBy !== 'recent') params.set('sort', sortBy);
  const url = `/api/inbox/conversations${params.toString() ? '?' + params.toString() : ''}`;
  const sessions = useSWR('/api/inbox/wa-sessions', fetcher, { refreshInterval: 60_000 });
  const tags = useSWR('/api/ops/tags', fetcher, { refreshInterval: 120_000 });

  async function bulk(action, extra = {}) {
    if (!selected.size) return;
    setBulkBusy(true);
    try {
      const r = await fetch('/api/inbox/conversations/bulk', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected), action, ...extra }),
      });
      if (!r.ok) throw new Error((await r.json()).message || 'bulk failed');
      setSelected(new Set());
      mutate();
    } catch (err) { alert(err.message); }
    finally { setBulkBusy(false); }
  }
  function toggleSelect(id, e) {
    e.preventDefault(); e.stopPropagation();
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  const { data, error, isLoading, mutate } = useSWR(url, fetcher, {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });

  // Live update on inbox events — re-fetch the list
  useSocket(
    {
      'crm:conv-updated': (payload) => {
        mutate();
        // Sound + notification only after initial render and only for non-self triggers
        if (!firstLoadRef.current && payload?.conversation_id) {
          const isNewConv = !seenConvIds.current.has(payload.conversation_id);
          if (isNewConv) {
            playSound({ frequency: 720, duration: 0.18 });
            showBrowserNotification({
              title: 'Pesan baru di inbox',
              body: `Conv #${payload.conversation_id}`,
              tag: `conv-${payload.conversation_id}`,
              onClick: () => router.push(`/inbox/${payload.conversation_id}`),
            });
          }
          seenConvIds.current.add(payload.conversation_id);
        }
      },
      'crm:handover': (payload) => {
        mutate();
        if (!firstLoadRef.current) {
          playSound({ frequency: 440, duration: 0.32, type: 'square' });
          showBrowserNotification({
            title: '⚠️ Handover butuh operator',
            body: `${payload?.reason || 'tool_error'} · ${payload?.summary?.slice(0, 80) || ''}`,
            tag: `ho-${payload?.conversation_id || ''}`,
            onClick: () => router.push(`/inbox/${payload?.conversation_id}`),
          });
        }
      },
    },
    { joinRooms: [{ event: 'crm:join-inbox' }] }
  );

  const items = data?.items || [];

  // Track seen conv IDs so we know what's "new" on subsequent updates
  useEffect(() => {
    if (data?.items) {
      data.items.forEach((c) => seenConvIds.current.add(c.id));
      firstLoadRef.current = false;
    }
  }, [data?.items]);

  return (
    <Layout title="Inbox — Tiara">
      <div className="px-3 sm:px-4 py-3 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-slate-800 flex items-center gap-2 tracking-tight">
            💬 Inbox
            <span className="text-xs font-normal text-slate-500">
              ({isLoading ? '…' : `${items.length} hasil`})
            </span>
          </h1>
          {notif.supported && notif.state !== 'granted' && (
            <button
              onClick={notif.request}
              className="text-[11px] px-2 py-1 rounded-md text-violet-700 border border-violet-200 bg-violet-50 hover:bg-violet-100"
              title="Aktifkan notifikasi browser untuk pesan baru"
            >🔔 Notif</button>
          )}
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          <input
            type="search"
            placeholder="Cari nomor (62…)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 focus:bg-white"
          />
        </div>

        {/* Mobile chips — primary status filter */}
        <div className="sm:hidden flex gap-2 overflow-x-auto chips-row pb-1 mb-2 -mx-3 px-3">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                status === f.value
                  ? 'bg-violet-600 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >{f.label}</button>
          ))}
          <span className="w-px self-stretch bg-slate-200 mx-0.5" />
          <button
            onClick={() => setQueue(queue === 'mine' ? '' : 'mine')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
              queue === 'mine' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >Saya</button>
          <button
            onClick={() => setQueue(queue === 'unassigned' ? '' : 'unassigned')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
              queue === 'unassigned' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >Unassigned</button>
          <button
            onClick={() => setSortBy(sortBy === 'temp' ? 'recent' : 'temp')}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
              sortBy === 'temp' ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-700'
            }`}
          >🔥 Hot</button>
        </div>

        {/* Desktop selects — full filter set */}
        <div className="hidden sm:flex flex-wrap gap-2 mb-3">
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatus(f.value)}
                className={`px-3 py-1.5 text-xs rounded-md transition ${
                  status === f.value
                    ? 'bg-violet-600 text-white'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >{f.label}</button>
            ))}
          </div>
          {(sessions.data?.items || []).length > 0 && (
            <select
              value={waSession}
              onChange={(e) => setWaSession(e.target.value)}
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
            >
              <option value="">Semua nomor WA</option>
              {sessions.data.items.map((s) => (
                <option key={s.name} value={s.name}>{s.name} ({s.count})</option>
              ))}
            </select>
          )}
          <select
            value={queue}
            onChange={(e) => setQueue(e.target.value)}
            className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
          >
            <option value="">Semua queue</option>
            <option value="mine">Queue saya</option>
            <option value="unassigned">Belum diambil</option>
          </select>
          {(tags.data?.items || []).length > 0 && (
            <select
              value={tagId}
              onChange={(e) => setTagId(e.target.value)}
              className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
            >
              <option value="">Semua tag</option>
              {tags.data.items.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.conv_count})</option>
              ))}
            </select>
          )}
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
            title="Filter pipeline stage"
          >
            <option value="">Semua stage</option>
            <option value="baru">Baru</option>
            <option value="tertarik">Tertarik</option>
            <option value="form_dikirim">Form Dikirim</option>
            <option value="order_submitted">Submitted</option>
            <option value="paid">Paid</option>
            <option value="delivered">Delivered</option>
            <option value="lost">Lost</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
          >
            <option value="recent">Sort: Recent</option>
            <option value="temp">🔥 Sort: Temperature</option>
          </select>
        </div>

        {selected.size > 0 && (
          <div className="bg-violet-50 border border-violet-200 rounded-xl px-3 py-2 mb-2 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-violet-800 font-semibold">{selected.size} dipilih</span>
            <button onClick={() => bulk('close')} disabled={bulkBusy}
              className="text-[11px] px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">Close</button>
            <button onClick={() => bulk('reopen')} disabled={bulkBusy}
              className="text-[11px] px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">Reopen</button>
            <button onClick={() => bulk('shadow_on')} disabled={bulkBusy}
              className="text-[11px] px-2 py-0.5 rounded bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">Shadow ON</button>
            {(tags.data?.items || []).length > 0 && (
              <select
                disabled={bulkBusy}
                onChange={(e) => { if (e.target.value) bulk('tag', { tag_id: parseInt(e.target.value) }); e.target.value = ''; }}
                className="text-[11px] px-2 py-0.5 rounded bg-white border border-slate-200"
                defaultValue=""
              >
                <option value="">+ Tag…</option>
                {tags.data.items.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <button onClick={() => setSelected(new Set())}
              className="text-[11px] px-2 py-0.5 rounded text-slate-500 hover:text-slate-700 ml-auto">Batal</button>
          </div>
        )}

        {error && (
          <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5 mb-2">
            {error.message || 'Gagal memuat'}
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {items.length === 0 && !isLoading && (
            <div className="px-6 py-12 text-center text-sm text-slate-400">
              Belum ada percakapan.
            </div>
          )}
          {items.map((conv) => {
            const st = convStatusLabel(conv);
            const phone = conv.real_phone || conv.phone || '';
            const display = formatDisplayName(conv.push_name, phone);
            const formattedPhone = formatPhone(phone);
            const hasName = display && display !== formattedPhone;
            const hue = (phone.split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 7) % 360;
            const initial = (hasName ? display : phone || '?').toString().slice(0, 1).toUpperCase();
            return (
              <div key={conv.id} className="flex items-stretch border-b border-slate-100 last:border-b-0">
                <button
                  type="button"
                  onClick={(e) => toggleSelect(conv.id, e)}
                  aria-label={selected.has(conv.id) ? 'Unselect' : 'Select'}
                  className={`px-2 flex items-center justify-center transition ${
                    selected.has(conv.id) ? 'bg-violet-50 text-violet-700' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <span className="w-4 h-4 inline-flex items-center justify-center rounded border border-slate-300 text-[10px]">
                    {selected.has(conv.id) ? '✓' : ''}
                  </span>
                </button>
                <Link
                  href={`/inbox/${conv.id}`}
                  className="flex items-start gap-3 flex-1 min-w-0 px-3 py-3 hover:bg-slate-50 active:bg-slate-100"
                >
                  <div
                    className="w-11 h-11 rounded-full grid place-items-center text-sm font-bold text-white flex-shrink-0 shadow-sm"
                    style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 75% 60%))` }}
                  >{initial}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="font-semibold text-[13.5px] text-slate-800 truncate min-w-0 flex items-center gap-1.5">
                        {hasName ? display : formattedPhone}
                        {hasName && <span className="text-[11px] text-slate-400 font-normal truncate">{formattedPhone}</span>}
                      </div>
                      <div className="text-[11px] text-slate-400 whitespace-nowrap flex-shrink-0">
                        {formatRelative(conv.last_at || conv.last_message_at)}
                      </div>
                    </div>
                    <div className="text-[12.5px] text-slate-500 truncate mt-0.5">
                      {conv.last_sender === 'customer' ? '' : <span className="text-emerald-600">↗ </span>}
                      {truncate(conv.last_body || '(no message)', 90)}
                    </div>
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <span className={`status-pill ${st.cls}`}>{st.label}</span>
                      {conv.pipeline_stage && conv.pipeline_stage !== 'baru' && (
                        <PipelineStageBadge stage={conv.pipeline_stage} override={conv.manual_stage_override} size="xs" />
                      )}
                      {conv.lead_temperature && conv.lead_temperature !== 'cold' && (
                        <LeadTempBadge temp={conv.lead_temperature} score={conv.lead_score} size="xs" />
                      )}
                      {isLidPhone(conv.phone) && !conv.real_phone && (
                        <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">set No.</span>
                      )}
                      {conv.last_intent && (
                        <span className="text-[10px] text-slate-400">· {conv.last_intent}</span>
                      )}
                      {Array.isArray(conv.tags) && conv.tags.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] border ${TAG_COLOR[t.color] || TAG_COLOR.slate}`}
                          title={t.auto ? 'Auto-tagged' : undefined}
                        >
                          {t.auto && <span className="opacity-70">✨</span>}
                          {t.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      </div>
    </Layout>
  );
}
