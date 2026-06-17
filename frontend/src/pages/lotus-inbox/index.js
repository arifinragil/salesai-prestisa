import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { formatRelative, truncate, formatPhone } from '@/lib/format';
import TabStrip from '@/components/lotus-inbox/TabStrip';
import TodayTasksCard from '@/components/lotus-inbox/TodayTasksCard';

const STATUS_FILTERS = [
  { value: '',       label: 'Semua' },
  { value: 'active', label: 'Aktif' },
  { value: 'closed', label: 'Closed' },
  { value: 'spam',   label: 'Spam' },
];

const QUEUE_FILTERS = [
  { value: '',           label: 'Semua' },
  { value: 'mine',       label: 'Saya' },
  { value: 'unassigned', label: 'Unassigned' },
];

export default function LotusInboxList() {
  const [status, setStatus] = useState('');
  const [queue,  setQueue]  = useState('');
  const [sales,  setSales]  = useState([]); // array of names (multi)
  const [salesOpen, setSalesOpen] = useState(false);
  const [salesQ, setSalesQ] = useState('');
  const salesBoxRef = useRef(null);
  const [q,      setQ]      = useState('');
  const [offset, setOffset] = useState(0);
  const [tab,    setTab]    = useState('all');
  const [scope,  setScope]  = useState('team');
  const limit = 100;

  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (queue)  params.set('queue', queue);
  if (sales.length) params.set('sales', sales.join(','));
  if (q)      params.set('q', q);
  params.set('tab', tab);
  if (isAdmin && scope === 'mine') params.set('scope', 'mine');
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  const countsParams = new URLSearchParams();
  if (isAdmin && scope === 'mine') countsParams.set('scope', 'mine');
  const countsQs = countsParams.toString();
  const { data: countsData } = useSWR(
    `/api/lotus-inbox/tab-counts${countsQs ? `?${countsQs}` : ''}`, fetcher,
    { refreshInterval: 60_000 }
  );
  const counts = countsData?.counts;

  const { data: salesData } = useSWR('/api/lotus-inbox/sales-options', fetcher);
  const salesOptions = salesData?.items || [];

  // Close dropdown on outside click
  useEffect(() => {
    if (!salesOpen) return;
    const onClick = (e) => {
      if (salesBoxRef.current && !salesBoxRef.current.contains(e.target)) {
        setSalesOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [salesOpen]);

  const toggleSales = (name) => {
    setOffset(0);
    setSales((prev) => prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]);
  };
  const filteredSales = salesQ
    ? salesOptions.filter((s) => s.name.toLowerCase().includes(salesQ.toLowerCase()))
    : salesOptions;

  const { data, error, isLoading, mutate } = useSWR(
    `/api/lotus-inbox/contacts?${params.toString()}`, fetcher,
    { refreshInterval: 30_000 }
  );

  // Realtime: refresh list on outbound/inbound from any lotus conv
  useSocket({
    'crm:lotus-conv-updated': () => mutate(),
  }, { joinRooms: [{ event: 'crm:join-lotus-inbox' }] });

  const items = data?.items || [];

  return (
    <Layout title="Lotus Inbox">
      <div className="px-3 sm:px-4 py-3 max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-slate-800 flex items-center gap-2 tracking-tight">
            🪷 Lotus Inbox
            <span className="text-xs font-normal text-slate-500">
              ({data?.count ?? 0} hasil)
            </span>
          </h1>
        </div>

        <TodayTasksCard counts={counts} onPick={setTab} />

        {isAdmin && (
          <div className="flex gap-1 mb-2">
            <button
              onClick={() => { setScope('team'); setOffset(0); }}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                scope === 'team' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >Tim</button>
            <button
              onClick={() => { setScope('mine'); setOffset(0); }}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                scope === 'mine' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >Saya</button>
          </div>
        )}

        <TabStrip tab={tab} counts={counts} onChange={(t) => { setTab(t); setOffset(0); }} />

        {/* Search */}
        <div className="relative mb-2">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          <input
            type="text"
            placeholder="Cari nama atau nomor…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            className="w-full pl-9 pr-3 py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-300 focus:bg-white"
          />
        </div>

        {/* Mobile chips */}
        <div className="sm:hidden flex gap-2 overflow-x-auto chips-row pb-1 mb-2 -mx-3 px-3">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.value}
              onClick={() => { setStatus(s.value); setOffset(0); }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                status === s.value
                  ? 'bg-violet-600 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >{s.label}</button>
          ))}
          <span className="w-px self-stretch bg-slate-200 mx-0.5" />
          {QUEUE_FILTERS.filter(q=>q.value).map((s) => (
            <button
              key={s.value}
              onClick={() => { setQueue(queue === s.value ? '' : s.value); setOffset(0); }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap ${
                queue === s.value
                  ? 'bg-violet-600 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >{s.label}</button>
          ))}
        </div>

        {/* Desktop selects */}
        <div className="hidden sm:flex flex-wrap gap-2 mb-3">
          <select
            value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <select
            value={queue} onChange={(e) => { setQueue(e.target.value); setOffset(0); }}
            className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm"
          >
            {QUEUE_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
<div className="relative" ref={salesBoxRef}>
            <button
              type="button"
              onClick={() => setSalesOpen((v) => !v)}
              className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white hover:bg-slate-50 flex items-center gap-1"
              title="Filter sales (multi-select)"
            >
              <span className="truncate max-w-[180px]">
                {sales.length === 0
                  ? 'Semua Sales'
                  : sales.length === 1
                    ? sales[0]
                    : `${sales.length} sales dipilih`}
              </span>
              <span className="text-slate-400 text-xs">▾</span>
            </button>
            {salesOpen && (
              <div className="absolute z-20 mt-1 w-72 max-h-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg flex flex-col">
                <div className="p-2 border-b border-slate-100 flex items-center gap-2">
                  <input
                    type="text"
                    autoFocus
                    placeholder="Cari sales…"
                    value={salesQ}
                    onChange={(e) => setSalesQ(e.target.value)}
                    className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-violet-300"
                  />
                  {sales.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setSales([]); setOffset(0); }}
                      className="text-[11px] text-rose-600 hover:underline whitespace-nowrap"
                    >Clear</button>
                  )}
                </div>
                <div className="overflow-y-auto flex-1">
                  {filteredSales.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-slate-400 text-center">Tidak ada hasil</div>
                  ) : filteredSales.map((s) => (
                    <label key={s.name} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={sales.includes(s.name)}
                        onChange={() => toggleSales(s.name)}
                        className="w-4 h-4 accent-violet-600"
                      />
                      <span className="truncate flex-1">{s.name}</span>
                      <span className="text-[10px] text-slate-400">{s.n}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => mutate()}
            className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50"
          >Refresh</button>
        </div>

        {error && (
          <div className="text-rose-700 bg-rose-50 border border-rose-200 px-3 py-2 rounded mb-3 text-sm">
            {error.message || 'Gagal memuat'}
          </div>
        )}
        {isLoading && !data && (
          <div className="text-slate-500 text-sm py-6 text-center">Memuat…</div>
        )}

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {items.length === 0 && !isLoading ? (
            <div className="text-slate-500 text-sm py-12 text-center">Tidak ada percakapan.</div>
          ) : items.map((it) => (
            <Link
              key={it.lotus_id}
              href={`/lotus-inbox/${encodeURIComponent(it.lotus_id)}`}
              className="flex items-start gap-3 px-3 py-3 border-b border-slate-100 hover:bg-slate-50 active:bg-slate-100 cursor-pointer"
            >
              <div className="w-11 h-11 rounded-full grid place-items-center text-sm font-bold text-white flex-shrink-0 shadow-sm"
                style={{ background: `linear-gradient(135deg, hsl(${((it.cust_number||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0) * 7) % 360} 70% 55%), hsl(${((it.cust_number||'').split('').reduce((a,c)=>a+c.charCodeAt(0),0) * 7 + 40) % 360} 75% 60%))` }}>
                {(it.cust_name || it.cust_number || '?').toString().slice(0,1).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
<div className="font-medium text-sm text-slate-800 truncate">
                    {it.cust_name || formatPhone(it.cust_number) || it.cust_number}
                    {it.lotus_assign_to && (
                      <span className="ml-1.5 text-[11px] font-normal text-violet-600">
                        — sales: {it.lotus_assign_to}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 whitespace-nowrap">
                    {formatRelative(it.last_at)}
                  </div>
                </div>
                <div className="text-xs text-slate-500 truncate">
                  {it.last_message_from === 'outbound' && <span className="text-emerald-600">↗ </span>}
                  {truncate(it.last_body || '', 90)}
                </div>
                <div className="flex flex-wrap items-center gap-1 mt-1 text-[10px]">
                  {it.label && (
                    <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                      {it.label}
                    </span>
                  )}
                  {it.lead_product && (
                    <span className="px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded">
                      {it.lead_product}
                    </span>
                  )}
                  {it.unread > 0 && (
                    <span className="px-1.5 py-0.5 bg-rose-500 text-white rounded font-bold">
                      {it.unread}
                    </span>
                  )}
                  {it.assigned_staff_id && (
                    <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded">
                      assigned
                    </span>
                  )}
                  {it.status && it.status !== 'active' && (
                    <span className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded">
                      {it.status}
                    </span>
                  )}
                  {it.city_name && (
                    <span className="text-slate-400">· {it.city_name}</span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div className="flex items-center justify-between mt-3 text-sm">
          <div className="text-slate-500">
            Hal. {Math.floor(offset / limit) + 1} · {items.length} / {data?.count ?? '?'} hasil
          </div>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50"
            >‹ Sebelumnya</button>
            <button
              disabled={items.length < limit}
              onClick={() => setOffset(offset + limit)}
              className="px-3 py-1.5 border border-slate-300 rounded-lg disabled:opacity-40 hover:bg-slate-50"
            >Berikutnya ›</button>
          </div>
        </div>
      </div>
    </Layout>
  );
}
