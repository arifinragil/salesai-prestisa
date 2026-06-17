import { useRouter } from 'next/router';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import ManagerViewTab from '../../components/lotus-inbox/managerView/ManagerViewTab';
import { useSocket } from '@/lib/useSocket';
import { formatRelative, formatPhone } from '@/lib/format';

const PAGE_SIZE = 50;

export default function LotusConvDetail() {
  const router = useRouter();
  const { id } = router.query;
  const encId = id ? encodeURIComponent(id) : '';
  const scrollRef = useRef(null);

  const detail = useSWR(id ? `/api/lotus-inbox/contacts/${encId}` : null, fetcher, { refreshInterval: 30_000 });
  // POS customer lookup (MySQL → customer + orders + sales owner)
  const custInfo = useSWR(id ? `/api/lotus-inbox/contacts/${encId}/customer-info` : null, fetcher, { revalidateOnFocus: false });

  // Infinite scroll state. `messages` ordered oldest → newest. `cursor` is the
  // oldest message's created_at (used as ?before= to fetch older page).
  const [messages, setMessages]   = useState([]);
  const [cursor, setCursor]       = useState(null);
  const [hasMore, setHasMore]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [msgsErr, setMsgsErr]     = useState(null);
  const [draft, setDraft]         = useState('');
  const [sending, setSending]     = useState(false);
  const [attachFile, setAttachFile] = useState(null); // File obj
  const [attachPreview, setAttachPreview] = useState(null); // dataURL for image
  const fileInputRef = useRef(null);
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary]     = useState(null);
  // Co-Pilot 4-option suggestions
  const [sugBusy, setSugBusy]     = useState(false);
  const [sugData, setSugData]     = useState(null); // { options, generation_ms, low_confidence, log_id, inbound_preview }
  const [sugCollapsed, setSugCollapsed] = useState(false);
  const [sugRated, setSugRated]   = useState({}); // rank → 'up'|'down'
  // Profile drawer (mobile)
  const [profileOpen, setProfileOpen] = useState(false);
  // Tab strip: 'chat' (default) or 'manager_view'
  const [tab, setTab] = useState('chat');
  useEffect(() => {
    if (router.query.tab === 'manager_view') setTab('manager_view');
    else if (router.query.tab === 'chat') setTab('chat');
  }, [router.query.tab]);
  // Order detail modal (foto hasil + lokasi)
  const [orderDetailId, setOrderDetailId] = useState(null);
  const orderDetail = useSWR(
    orderDetailId ? `/api/lotus-inbox/orders/${orderDetailId}/details` : null,
    fetcher,
    { revalidateOnFocus: false }
  );
  const [lightboxUrl, setLightboxUrl] = useState(null);
  // HSM picker
  const [hsmOpen, setHsmOpen]     = useState(false);
  const [templates, setTemplates] = useState([]);
  const [hsmName, setHsmName]     = useState('');
  const [hsmParams, setHsmParams] = useState([]);
  const [hsmBusy, setHsmBusy]     = useState(false);
  const lastIdRef = useRef(null);

  // Initial load + reset on contact change
  useEffect(() => {
    if (!id) return;
    if (lastIdRef.current === id) return;
    lastIdRef.current = id;
    setMessages([]); setCursor(null); setHasMore(true); setMsgsErr(null);
    setSugData(null); setSugCollapsed(false); setSummary(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await api(`/api/lotus-inbox/contacts/${encId}/messages?limit=${PAGE_SIZE}`);
        if (cancelled) return;
        setMessages(r.messages || []);
        setHasMore(!!r.has_more);
        setCursor(r.next_before || null);
        // Scroll to bottom on initial load (after paint)
        setTimeout(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }, 0);
      } catch (e) { if (!cancelled) setMsgsErr(e.message); }
    })();
    return () => { cancelled = true; };
  }, [id, encId]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight || 0;
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(cursor)}`);
      const older = r.messages || [];
      if (older.length) {
        setMessages((cur) => [...older, ...cur]);
      }
      setHasMore(!!r.has_more);
      setCursor(r.next_before || null);
      // Preserve scroll position so user isn't jolted to top after prepend
      setTimeout(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      }, 0);
    } catch (e) { setMsgsErr(e.message); }
    finally { setLoadingMore(false); }
  }, [cursor, loadingMore, hasMore, encId]);

  // Auto-trigger load-older when user scrolls near top
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loadingMore || !hasMore) return;
    if (el.scrollTop < 80) loadOlder();
  }, [loadOlder, loadingMore, hasMore]);

  // Periodic refresh of newest messages (background polling); merge by id
  useEffect(() => {
    if (!id) return;
    const iv = setInterval(async () => {
      try {
        const r = await api(`/api/lotus-inbox/contacts/${encId}/messages?limit=${PAGE_SIZE}`);
        const fresh = r.messages || [];
        setMessages((cur) => {
          const seen = new Set(cur.map((m) => m.id));
          const adds = fresh.filter((m) => !seen.has(m.id));
          if (!adds.length) return cur;
          // Append newer (fresh array is oldest→newest of the LAST page)
          return [...cur, ...adds.filter((m) => {
            // Only append messages newer than current newest
            const curNewestAt = cur.length ? new Date(cur[cur.length - 1].created_at).getTime() : 0;
            return new Date(m.created_at).getTime() > curNewestAt;
          })];
        });
      } catch {}
    }, 15_000);
    return () => clearInterval(iv);
  }, [id, encId]);

  // Jump to bottom on first load; afterwards only auto-scroll when user is near bottom
  const firstScrollRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (firstScrollRef.current) {
      firstScrollRef.current = false;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      });
      return;
    }
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Reset first-scroll flag when contact changes
  useEffect(() => { firstScrollRef.current = true; }, [id]);

  // Realtime: subscribe to crm:lotus:<id> room
  useSocket({
    'crm:lotus-message': (payload) => {
      if (!payload || payload.lotus_id !== id) return;
      setMessages((cur) => {
        // Dedup by id; also avoid double-append if same body+direction within 5s
        if (payload.message?.id && cur.some((m) => m.id === payload.message.id)) return cur;
        const tNew = new Date(payload.message.created_at).getTime();
        const dupe = cur.some((m) =>
          m.direction === payload.message.direction &&
          m.body === payload.message.body &&
          Math.abs(new Date(m.created_at).getTime() - tNew) < 5000
        );
        if (dupe) return cur;
        return [...cur, payload.message];
      });
    },
  }, {
    joinRooms: id ? [{ event: 'crm:join-lotus', arg: id }] : [],
  });

  if (!id) return null;
  if (detail.error) return (
    <Layout title="Lotus"><div className="p-6 text-rose-700">{detail.error.message}</div></Layout>
  );

  const contact = detail.data?.contact;
  const state   = detail.data?.state || {};

  const lastInbound = contact?.last_inbound_at ? new Date(contact.last_inbound_at) : null;
  const hoursSinceInbound = lastInbound ? (Date.now() - lastInbound.getTime()) / 3600_000 : Infinity;
  const windowOpen = hoursSinceInbound <= 24;

  async function callAction(path, body) {
    setBusy(true); setErr('');
    try {
      await api(`/api/lotus-inbox/contacts/${encId}${path}`, { method: 'POST', body });
      detail.mutate();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function refreshLatest() {
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/messages?limit=${PAGE_SIZE}`);
      const fresh = r.messages || [];
      setMessages((cur) => {
        const seen = new Set(cur.map((m) => m.id));
        const adds = fresh.filter((m) => !seen.has(m.id));
        return adds.length ? [...cur, ...adds] : cur;
      });
    } catch {}
  }

  async function send() {
    if (sending) return;
    const text = draft.trim();
    // File path
    if (attachFile) {
      setSending(true); setErr('');
      try {
        const fd = new FormData();
        fd.append('file', attachFile);
        if (text) fd.append('caption', text);
        const res = await fetch(`/api/lotus-inbox/contacts/${encId}/send-file`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.message || `HTTP ${res.status}`);
        setDraft(''); setAttachFile(null); setAttachPreview(null);
        if (r.sender_was_substituted) {
          setErr(`ℹ Dikirim via ${r.sender_used} (nomor business asli tidak terdaftar di Vonage).`);
        }
        setTimeout(refreshLatest, 800);
      } catch (e) {
        setErr(e.message || 'Gagal kirim lampiran');
      } finally {
        setSending(false);
      }
      return;
    }
    // Text-only path
    if (!text) return;
    setSending(true); setErr('');
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/send`, { method: 'POST', body: { body: text } });
      setDraft('');
      if (r.sender_was_substituted) {
        setErr(`ℹ Dikirim via ${r.sender_used} (nomor business asli tidak terdaftar di Vonage).`);
      }
      setTimeout(refreshLatest, 800);
    } catch (e) {
      setErr(e.body?.message || e.message || 'Gagal kirim');
    } finally {
      setSending(false);
    }
  }

  function pickFile() { fileInputRef.current?.click(); }
  function onFilePicked(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) { setErr('File terlalu besar (max 25 MB).'); return; }
    setAttachFile(f);
    setErr('');
    if (f.type.startsWith('image/')) {
      const fr = new FileReader();
      fr.onload = () => setAttachPreview(fr.result);
      fr.readAsDataURL(f);
    } else {
      setAttachPreview(null);
    }
  }
  function clearAttach() { setAttachFile(null); setAttachPreview(null); }

  async function suggest() {
    setSuggesting(true); setErr('');
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/ai-suggest-reply`, { method: 'POST', body: {} });
      if (r.reply) setDraft(r.reply);
    } catch (e) { setErr(e.message); }
    finally { setSuggesting(false); }
  }
  async function genSuggestions() {
    if (sugBusy) return;
    setSugBusy(true); setErr('');
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/ai-suggestions`, { method: 'POST', body: {} });
      setSugData(r);
      setSugCollapsed(false);
      setSugRated({});
    } catch (e) { setErr(e.message); }
    finally { setSugBusy(false); }
  }
  async function rateSuggestion(rank, vote, optText) {
    if (!sugData?.log_id) return;
    setSugRated((prev) => ({ ...prev, [rank]: vote }));
    try {
      await api(`/api/lotus-inbox/contacts/${encId}/suggestion/${sugData.log_id}/rate`, {
        method: 'POST',
        body: {
          vote,
          question: sugData.inbound_preview || '',
          answer: optText,
        },
      });
    } catch { /* best-effort */ }
  }
  function useSuggestion(opt) { setDraft(opt.text); }
  async function doSummary() {
    setSummarizing(true); setErr('');
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/ai-summary`, { method: 'POST', body: {} });
      setSummary(r.summary);
    } catch (e) { setErr(e.message); }
    finally { setSummarizing(false); }
  }

  async function openHsm() {
    setHsmOpen(true); setErr('');
    if (templates.length === 0) {
      try {
        const r = await api('/api/lotus-inbox/templates');
        setTemplates(r.items || []);
      } catch (e) { setErr(e.message); }
    }
  }
  function pickTemplate(name) {
    setHsmName(name);
    const t = templates.find((x) => x.template_name === name);
    setHsmParams(new Array(t?.var_count || 0).fill(''));
  }
  function renderHsm(content, params) {
    if (!content) return '';
    return params.reduce(
      (acc, p, i) => acc.replace(new RegExp('\\{\\{' + (i + 1) + '\\}\\}', 'g'), p || `{{${i + 1}}}`),
      content
    );
  }
  async function sendHsm() {
    if (!hsmName || hsmBusy) return;
    if (hsmParams.some((p) => p.trim() === '')) {
      setErr('Isi semua parameter dulu.');
      return;
    }
    setHsmBusy(true); setErr('');
    try {
      const r = await api(`/api/lotus-inbox/contacts/${encId}/send-template`, {
        method: 'POST',
        body: { template_name: hsmName, params: hsmParams, language: 'id' },
      });
      if (r.sender_was_substituted) {
        setErr(`ℹ HSM dikirim via ${r.sender_used} (nomor business asli tidak terdaftar di Vonage).`);
      }
      setHsmOpen(false); setHsmName(''); setHsmParams([]);
      setTimeout(refreshLatest, 800);
    } catch (e) {
      setErr(e.body?.message || e.message || 'Gagal kirim HSM');
    } finally {
      setHsmBusy(false);
    }
  }

  const initial = (contact?.cust_name || contact?.cust_number || '?').toString().slice(0,1).toUpperCase();
  const avatarHue = ((contact?.cust_number || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) * 7) % 360;

  return (
    <Layout title={contact?.cust_name || 'Lotus'}>
<div className="flex flex-col lg:grid lg:grid-cols-[1fr,320px] gap-0 lg:gap-3 lg:p-3 lg:max-w-7xl lg:mx-auto h-[calc(100dvh-49px-72px)] lg:h-full relative">
        {/* Chat panel */}
        <div className="flex flex-col bg-white lg:rounded-lg lg:border lg:border-slate-200 overflow-hidden flex-1 min-h-0">
          {/* Header */}
          <div className="w-full px-2 py-2 border-b border-slate-200 flex items-center gap-2 bg-white">
            <Link
              href="/lotus-inbox"
              className="lg:hidden w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 flex-shrink-0"
              aria-label="Kembali"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            </Link>
            {/* Tap area: customer card → opens detail drawer on mobile */}
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="lg:cursor-default flex items-center gap-2 min-w-0 flex-1 text-left py-0.5 active:bg-slate-100 lg:active:bg-transparent rounded-md"
            >
              <div
                className="w-8 h-8 rounded-full grid place-items-center text-white text-[11px] font-bold flex-shrink-0 shadow-sm"
                style={{ background: `linear-gradient(135deg, hsl(${avatarHue} 70% 55%), hsl(${(avatarHue + 40) % 360} 75% 60%))` }}
              >{initial}</div>
              <div className="min-w-0 flex-1">
<div className="font-semibold text-slate-800 text-[13px] leading-tight truncate">
                  {contact?.cust_name || formatPhone(contact?.cust_number)}
                  {contact?.lotus_assigned_to && (
                    <span className="ml-1.5 text-[11px] font-normal text-violet-600">
                      — sales: {contact.lotus_assigned_to}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-500 truncate leading-tight mt-0.5 flex items-center gap-1">
                  <span className={windowOpen ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold'}>
                    {windowOpen ? '🟢 terbuka' : '🔴 tutup'}
                  </span>
                  <span>·</span>
                  <span className="truncate">{formatPhone(contact?.cust_number)}</span>
                </div>
              </div>
            </button>
            {/* Quick action buttons (mobile only — info accessed via these) */}
            <button
              type="button"
              onClick={() => { setProfileOpen(true); doSummary(); }}
              className="lg:hidden w-9 h-9 inline-flex items-center justify-center rounded-md text-violet-700 bg-violet-50 hover:bg-violet-100 flex-shrink-0"
              aria-label="AI Summary"
              title="Generate AI Summary"
            >✨</button>
            <button
              type="button"
              onClick={() => setProfileOpen(true)}
              className="lg:hidden w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 flex-shrink-0"
              aria-label="Detail customer"
              title="Detail customer & CRM state"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="8.01"/><polyline points="11 12 12 12 12 16 13 16"/>
              </svg>
            </button>
          </div>

          {/* Tab strip */}
          <div className="flex border-b border-slate-200 bg-white text-xs">
            <button
              type="button"
              onClick={() => setTab('chat')}
              className={`px-3 py-2 ${tab === 'chat' ? 'border-b-2 border-violet-600 text-violet-700 font-semibold' : 'text-slate-500 hover:text-slate-700'}`}
            >💬 Chat</button>
            <button
              type="button"
              onClick={() => setTab('manager_view')}
              className={`px-3 py-2 ${tab === 'manager_view' ? 'border-b-2 border-violet-600 text-violet-700 font-semibold' : 'text-slate-500 hover:text-slate-700'}`}
            >🎯 Manager View</button>
          </div>

          {tab === 'manager_view' && (
            <div className="flex-1 overflow-y-auto bg-slate-50">
              <ManagerViewTab lotusId={id} />
            </div>
          )}

          <div style={tab === 'chat' ? undefined : { display: 'none' }} ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-2.5 py-2 space-y-1.5 bg-slate-50">
            {hasMore && (
              <div className="text-center py-1.5">
                <button
                  onClick={loadOlder} disabled={loadingMore}
                  className="text-[11px] px-3 py-0.5 border border-slate-300 rounded-full bg-white hover:bg-slate-50 disabled:opacity-50"
                >{loadingMore ? 'Memuat…' : 'Muat pesan lebih lama'}</button>
              </div>
            )}
            {!hasMore && messages.length > 0 && (
              <div className="text-[9px] text-slate-400 text-center py-1">— awal percakapan —</div>
            )}
            {msgsErr && (
              <div className="text-[11px] text-rose-700 text-center py-1">{msgsErr}</div>
            )}
            {messages.length === 0 && !msgsErr && (
              <div className="text-slate-400 text-xs text-center py-8">Belum ada pesan.</div>
            )}
            {messages.map((m) => {
              const mt = (m.message_type || 'text').toLowerCase();
              const isMedia = m.media && m.media.url;
              const mediaUnavailable = m.media && !m.media.url && m.media.unavailable;
              const isImage = mt === 'image' && isMedia;
              const isVideo = mt === 'video' && isMedia;
              const isDoc   = mt === 'document' && isMedia;
              const isLoc   = mt === 'location' && m.location;
              const isContacts = mt === 'contacts';
              return (
                <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[78%] rounded-2xl text-[13px] leading-snug overflow-hidden ${
                    m.direction === 'out'
                      ? 'bg-emerald-100 text-slate-800 rounded-br-sm'
                      : 'bg-white border border-slate-200 rounded-bl-sm'
                  } ${isImage || isVideo ? 'p-1' : 'px-2.5 py-1'}`}>
                    {m.hsm_name && (
                      <div className="text-[9px] text-amber-700 mb-0.5 px-1">📋 {m.hsm_name}</div>
                    )}
                    {m.staff_name && m.direction === 'out' && (
                      <div className="text-[9px] text-slate-500 mb-0.5 px-1">{m.staff_name}</div>
                    )}

                    {isImage && (
                      <button onClick={() => setLightboxUrl(m.media.url)} className="block w-full">
                        <img
                          src={m.media.url}
                          alt={m.media.caption || m.media.file_name || 'image'}
                          className="rounded-xl max-w-[260px] max-h-[320px] object-cover bg-slate-200"
                          loading="lazy"
                        />
                      </button>
                    )}

                    {isVideo && (
                      <video
                        controls
                        src={m.media.url}
                        className="rounded-xl max-w-[260px] max-h-[320px] bg-black"
                        preload="metadata"
                      />
                    )}

                    {isDoc && (
                      <a
                        href={m.media.url}
                        target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 px-2 py-1.5 bg-slate-50 rounded-lg hover:bg-slate-100"
                        download={m.media.file_name || undefined}
                      >
                        <span className="w-8 h-8 rounded-md bg-rose-100 text-rose-700 grid place-items-center text-sm flex-shrink-0">📄</span>
                        <span className="min-w-0">
                          <div className="font-semibold text-[12px] text-slate-800 truncate">{m.media.file_name || 'Dokumen'}</div>
                          <div className="text-[10px] text-slate-500 uppercase">{m.message_type}</div>
                        </span>
                      </a>
                    )}

                    {isLoc && (
                      <a
                        href={`https://www.google.com/maps?q=${m.location.latitude},${m.location.longitude}`}
                        target="_blank" rel="noreferrer"
                        className="block"
                      >
                        <div className="bg-slate-100 rounded-lg p-2 hover:bg-slate-200 flex items-center gap-2">
                          <span className="text-xl">📍</span>
                          <span className="min-w-0">
                            <div className="font-semibold text-[12px] text-slate-800">{m.location.name || 'Lokasi'}</div>
                            <div className="text-[10px] text-slate-500 truncate">
                              {m.location.address || `${m.location.latitude}, ${m.location.longitude}`}
                            </div>
                          </span>
                        </div>
                      </a>
                    )}

                    {isContacts && (
                      <div className="text-[12px] text-slate-600 italic">📇 Kontak dibagikan</div>
                    )}

                    {mediaUnavailable && (
                      <div className="flex items-center gap-2 px-2 py-2 bg-slate-50 border border-dashed border-slate-300 rounded-lg">
                        <span className="w-8 h-8 rounded-md bg-slate-200 text-slate-500 grid place-items-center text-sm flex-shrink-0">
                          {mt === 'image' ? '🖼️' : mt === 'video' ? '🎬' : mt === 'audio' ? '🎵' : '📄'}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold text-slate-600 uppercase">{mt}</div>
                          <div className="text-[10px] text-slate-500 truncate" title={m.media.file_name || ''}>
                            {m.media.file_name || 'file tidak tersedia'}
                          </div>
                          <div className="text-[9px] text-slate-400 italic">preview tidak tersedia (URL hilang dari arsip)</div>
                        </div>
                      </div>
                    )}

                    {(m.body || (isImage && m.media.caption) || (isVideo && m.media.caption)) && (
                      <div className={`whitespace-pre-wrap break-words ${isImage || isVideo ? 'px-1.5 pt-1' : ''}`}>
                        {m.body || m.media?.caption}
                      </div>
                    )}

                    {!isMedia && !isLoc && !isContacts && !m.body && (
                      <div className="text-slate-400 italic text-[11px]">[{m.message_type}]</div>
                    )}

                    <div className={`text-[9px] text-slate-400 mt-0.5 text-right ${isImage || isVideo ? 'px-1.5 pb-0.5' : ''}`}>
                      {m.created_at
                        ? `${new Date(m.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: '2-digit' })} ${new Date(m.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`
                        : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {tab === 'chat' && (<>
          {/* Co-Pilot 4-option suggestion panel */}
          <div className="border-t border-slate-200 bg-slate-50">
            {!sugData ? (
              <div className="px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">🤖 Co-Pilot — 4 saran balasan (3 case library + 1 AI)</span>
                <button
                  type="button"
                  onClick={genSuggestions}
                  disabled={sugBusy}
                  className="text-[11px] px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                >{sugBusy ? 'Generating…' : '✨ Generate'}</button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  onClick={() => setSugCollapsed(!sugCollapsed)}
                  className="w-full px-3 py-1.5 flex items-center justify-between text-[11px] text-slate-600 hover:bg-slate-100"
                >
                  <span>🤖 Co-Pilot · {sugData.options?.length || 0} suggestion · {sugData.generation_ms}ms{sugData.low_confidence ? ' · ⚠ low conf' : ''}</span>
                  <span>{sugCollapsed ? '▾' : '▴'}</span>
                </button>
                {!sugCollapsed && (
                  <div className="px-2.5 pb-2 space-y-1.5">
                    {(sugData.options || []).map((o) => (
                      <div key={o.rank} className="bg-white border border-slate-200 rounded p-1.5 hover:border-emerald-400">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-[10px] font-medium text-slate-500">
                            {o.rank}️⃣ {o.source === 'ai' ? '✨ AI' : o.source === 'fallback' ? '↩️ fallback' : (o.case_label || 'case')}
                            {o.confidence === 'low' && <span className="ml-1 text-amber-600">·low</span>}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              title="Saran bagus — simpan ke Q&A"
                              disabled={!!sugRated[o.rank]}
                              onClick={() => rateSuggestion(o.rank, 'up', o.text)}
                              className={`text-[11px] px-1.5 py-0.5 rounded border transition ${sugRated[o.rank] === 'up' ? 'bg-emerald-100 border-emerald-400 text-emerald-700' : 'border-slate-200 text-slate-400 hover:text-emerald-600 hover:border-emerald-300'} disabled:cursor-default`}
                            >👍</button>
                            <button
                              type="button"
                              title="Saran kurang tepat"
                              disabled={!!sugRated[o.rank]}
                              onClick={() => rateSuggestion(o.rank, 'down', o.text)}
                              className={`text-[11px] px-1.5 py-0.5 rounded border transition ${sugRated[o.rank] === 'down' ? 'bg-rose-100 border-rose-400 text-rose-700' : 'border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-300'} disabled:cursor-default`}
                            >👎</button>
                            <button
                              type="button"
                              onClick={() => useSuggestion(o)}
                              className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                            >Use [{o.rank}]</button>
                          </div>
                        </div>
                        <div className="text-[12px] text-slate-800 whitespace-pre-wrap leading-snug">{o.text}</div>
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={genSuggestions}
                        disabled={sugBusy}
                        className="text-[10px] px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-40"
                      >🔄 Regenerate</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 px-2.5 py-2 space-y-1.5">
            {!windowOpen && (
              <div className="text-[11px] bg-amber-50 text-amber-800 border border-amber-200 rounded px-2 py-1 flex items-center justify-between gap-2">
                <span>⚠️ Window tertutup — pakai HSM.</span>
                <button
                  onClick={openHsm}
                  className="px-2 py-0.5 text-[11px] bg-amber-600 text-white rounded hover:bg-amber-700 flex-shrink-0"
                >Kirim HSM</button>
              </div>
            )}
            {err && (
              <div className="text-[11px] bg-rose-50 text-rose-700 border border-rose-200 rounded px-2 py-1">
                {err}
              </div>
            )}
            {/* Attachment preview */}
            {attachFile && (
              <div className="flex items-center gap-2 p-1.5 bg-slate-50 border border-slate-200 rounded-lg">
                {attachPreview ? (
                  <img src={attachPreview} alt="" className="w-12 h-12 rounded object-cover flex-shrink-0" />
                ) : (
                  <span className="w-12 h-12 rounded bg-rose-100 text-rose-700 grid place-items-center text-lg flex-shrink-0">📄</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-slate-800 truncate">{attachFile.name}</div>
                  <div className="text-[10px] text-slate-500">
                    {(attachFile.size / 1024).toFixed(1)} KB · {attachFile.type || 'unknown'}
                  </div>
                </div>
                <button
                  onClick={clearAttach}
                  aria-label="Hapus lampiran"
                  className="w-7 h-7 rounded-md text-slate-500 hover:bg-slate-200 flex-shrink-0"
                >✕</button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,video/mp4,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={onFilePicked}
              className="hidden"
            />
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={pickFile}
                disabled={sending}
                className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-slate-600 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 flex-shrink-0 self-end"
                aria-label="Lampirkan file"
                title="Lampirkan gambar / dokumen"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </button>
              <textarea
                value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder={attachFile ? 'Caption (opsional)…' : 'Ketik balasan…'}
                rows={2}
                className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded-lg text-[13px] resize-none leading-snug"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                }}
              />
              <div className="flex flex-col gap-1">
                <button
                  onClick={send}
                  disabled={(!draft.trim() && !attachFile) || sending}
                  className="px-3 py-1 text-[13px] bg-emerald-600 text-white rounded-lg disabled:opacity-40 hover:bg-emerald-700"
                >{sending ? '…' : (attachFile ? 'Kirim 📎' : 'Kirim')}</button>
                <button
                  onClick={suggest}
                  disabled={suggesting}
                  className="px-2.5 py-1 text-[11px] border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                  title="AI suggest reply"
                >{suggesting ? '…' : '🤖 Saran'}</button>
                <button
                  onClick={openHsm}
                  className="px-2.5 py-1 text-[11px] border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50"
                  title="Kirim HSM template"
                >📋 HSM</button>
              </div>
            </div>
          </div>
          </>)}
        </div>

        {/* Order detail modal — purchase_order list + images */}
        {orderDetailId && (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center sm:p-4"
            onClick={() => setOrderDetailId(null)}
          >
            <div
              className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between z-10">
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-500 uppercase tracking-wide font-semibold">Detail Order</div>
                  <div className="font-mono text-sm font-semibold text-slate-800 truncate">
                    {orderDetail.data?.order?.order_number || `#${orderDetailId}`}
                  </div>
                </div>
                <button
                  onClick={() => setOrderDetailId(null)}
                  aria-label="Tutup"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                >✕</button>
              </div>

              {orderDetail.isLoading && !orderDetail.data && (
                <div className="p-6 text-center text-sm text-slate-400">Memuat detail order…</div>
              )}
              {orderDetail.error && (
                <div className="p-4 text-sm text-rose-600 bg-rose-50 border-b border-rose-200">
                  {orderDetail.error.message || 'Gagal memuat detail'}
                </div>
              )}
              {orderDetail.data?.order && (() => {
                const o = orderDetail.data.order;
                const items = orderDetail.data.items || [];
                const fmtIDR = (n) => n == null ? '—' : 'Rp ' + Number(n).toLocaleString('id-ID');
                const fmtDate = (d) => d ? new Date(d).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' }) : '—';
                const fmtDateTime = (d) => d ? new Date(d).toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
                return (
                  <div className="p-4 space-y-4">
                    {/* Summary */}
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <div className="text-slate-400 text-[10px] uppercase">Status</div>
                        <div className="font-semibold text-slate-800 capitalize">{o.status}</div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-[10px] uppercase">Payment</div>
                        <div className="font-semibold text-slate-800 capitalize">{o.payment_status || '—'}</div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-[10px] uppercase">Total</div>
                        <div className="font-semibold text-slate-800">{fmtIDR(o.total)}</div>
                      </div>
                      <div>
                        <div className="text-slate-400 text-[10px] uppercase">Pengiriman</div>
                        <div className="font-semibold text-slate-800">{fmtDate(o.min_delivery_date)}</div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-slate-400 text-[10px] uppercase">Sales Owner</div>
                        <div className="font-semibold text-slate-800">{o.order_owner_name || '—'}</div>
                      </div>
                    </div>

                    {/* PO items */}
                    {items.length === 0 ? (
                      <div className="text-sm text-slate-400 italic text-center py-4">
                        Belum ada PO untuk order ini.
                      </div>
                    ) : items.map((it) => (
                      <div key={it.id} className="border border-slate-200 rounded-xl p-3 space-y-3">
                        {/* PO header */}
                        <div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-sm text-slate-800 leading-tight">{it.product_name}</div>
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                <span className="font-mono">{it.product_code}</span> · qty {it.qty} · {fmtIDR(it.total)}
                              </div>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${
                              it.status === 'shipped' || it.status === 'delivered' ? 'bg-emerald-50 text-emerald-700' :
                              it.status === 'on shipping' ? 'bg-sky-50 text-sky-700' :
                              it.status === 'cancelled' ? 'bg-rose-50 text-rose-700' :
                              'bg-slate-100 text-slate-600'
                            }`}>{it.status || '—'}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            {it.supplier_name && <>🏪 {it.supplier_name}</>}
                            {it.po_owner_name && <> · {it.po_owner_name}</>}
                          </div>
                        </div>

                        {/* Images: foto hasil + lokasi + receipt + product */}
                        <div className="grid grid-cols-2 gap-2">
                          {it.images.real && (
                            <button onClick={() => setLightboxUrl(it.images.real)} className="block group">
                              <div className="aspect-square bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                                <img src={it.images.real} alt="Foto hasil" className="w-full h-full object-cover group-hover:opacity-90" loading="lazy" />
                              </div>
                              <div className="text-[10px] font-semibold text-slate-600 mt-1 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"/>📸 Foto Hasil
                              </div>
                            </button>
                          )}
                          {it.images.delivery_location && (
                            <button onClick={() => setLightboxUrl(it.images.delivery_location)} className="block group">
                              <div className="aspect-square bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                                <img src={it.images.delivery_location} alt="Foto lokasi" className="w-full h-full object-cover group-hover:opacity-90" loading="lazy" />
                              </div>
                              <div className="text-[10px] font-semibold text-slate-600 mt-1 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500"/>📍 Foto Lokasi
                              </div>
                            </button>
                          )}
                          {it.images.delivery_receipt && (
                            <button onClick={() => setLightboxUrl(it.images.delivery_receipt)} className="block group">
                              <div className="aspect-square bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                                <img src={it.images.delivery_receipt} alt="Tanda terima" className="w-full h-full object-cover group-hover:opacity-90" loading="lazy" />
                              </div>
                              <div className="text-[10px] font-semibold text-slate-600 mt-1 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"/>✍ Tanda Terima
                              </div>
                            </button>
                          )}
                          {it.images.product && (
                            <button onClick={() => setLightboxUrl(it.images.product)} className="block group">
                              <div className="aspect-square bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                                <img src={it.images.product} alt="Foto produk" className="w-full h-full object-cover group-hover:opacity-90" loading="lazy" />
                              </div>
                              <div className="text-[10px] font-semibold text-slate-600 mt-1 flex items-center gap-1">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400"/>🌷 Produk Katalog
                              </div>
                            </button>
                          )}
                          {!it.images.real && !it.images.delivery_location && !it.images.delivery_receipt && !it.images.product && (
                            <div className="col-span-2 text-[11px] text-slate-400 italic text-center py-3 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                              Belum ada foto untuk PO ini.
                            </div>
                          )}
                        </div>

                        {/* Recipient + delivery */}
                        <div className="text-[12px] space-y-1.5 pt-1 border-t border-slate-100">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Penerima</div>
                              <div className="font-semibold text-slate-700">{it.receiver_name || '—'}</div>
                              {it.receiver_phone && <div className="text-[11px] text-slate-500">{it.receiver_phone}</div>}
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Pengirim</div>
                              <div className="font-semibold text-slate-700">{it.sender_name || '—'}</div>
                              {it.sender_phone && <div className="text-[11px] text-slate-500">{it.sender_phone}</div>}
                            </div>
                          </div>
                          {it.shipping_address && (
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Alamat</div>
                              <div className="text-slate-700 text-[12px]">{it.shipping_address}</div>
                            </div>
                          )}
                          {it.greetings && (
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Ucapan</div>
                              <div className="text-slate-700 italic text-[12px] whitespace-pre-wrap">{it.greetings}</div>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Jadwal</div>
                              <div className="text-slate-700">{fmtDateTime(it.date_time)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-400 uppercase">Dikirim</div>
                              <div className="text-slate-700">{fmtDateTime(it.shipped_date)}</div>
                            </div>
                          </div>
                          {it.tracking_number && (
                            <div className="text-[11px]">
                              <span className="text-slate-400">Resi:</span> <span className="font-mono text-slate-700">{it.tracking_number}</span>
                              {it.shipping_expedition && <span className="text-slate-500"> · {it.shipping_expedition}</span>}
                            </div>
                          )}
                          {it.notes && (
                            <div className="text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1">
                              📝 {it.notes}
                            </div>
                          )}
                          {it.complaint_notes && (
                            <div className="text-[11px] text-rose-700 bg-rose-50 rounded px-2 py-1 border border-rose-100">
                              ⚠ Komplain: {it.complaint_notes}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Image lightbox */}
        {lightboxUrl && (
          <div
            className="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4"
            onClick={() => setLightboxUrl(null)}
          >
            <button
              onClick={() => setLightboxUrl(null)}
              aria-label="Tutup"
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-xl flex items-center justify-center"
            >✕</button>
            <img
              src={lightboxUrl}
              alt=""
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* HSM picker modal */}
        {hsmOpen && (
          <div className="fixed inset-0 bg-black/40 z-50 grid place-items-center p-4" onClick={() => !hsmBusy && setHsmOpen(false)}>
            <div className="bg-white rounded-xl border border-slate-200 max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">Kirim HSM Template</h3>
                <button onClick={() => !hsmBusy && setHsmOpen(false)} className="text-slate-400 hover:text-slate-600">✕</button>
              </div>
              {templates.length === 0 ? (
                <div className="text-sm text-slate-500 py-4 text-center">Memuat template…</div>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Template</label>
                    <select
                      value={hsmName}
                      onChange={(e) => pickTemplate(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                    >
                      <option value="">— pilih template —</option>
                      {templates.map((t) => (
                        <option key={t.template_name} value={t.template_name}>
                          {t.template_name} ({t.var_count} var{t.header_image ? ' · header' : ''})
                        </option>
                      ))}
                    </select>
                  </div>
                  {hsmName && (() => {
                    const t = templates.find((x) => x.template_name === hsmName);
                    if (!t) return null;
                    return (
                      <>
                        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 whitespace-pre-wrap">
                          {t.content}
                        </div>
                        {t.header_image && (
                          <div className="text-[11px] text-slate-500">
                            Header image: <a href={t.header_image} target="_blank" rel="noreferrer" className="text-sky-600 underline">{t.header_image}</a>
                          </div>
                        )}
                        {hsmParams.map((v, i) => (
                          <div key={i}>
                            <label className="text-xs text-slate-500 block mb-1">Param {`{{${i + 1}}}`}</label>
                            <input
                              type="text" value={v}
                              onChange={(e) => {
                                const next = [...hsmParams];
                                next[i] = e.target.value;
                                setHsmParams(next);
                              }}
                              className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm"
                              placeholder={`Nilai untuk parameter ${i + 1}`}
                            />
                          </div>
                        ))}
                        {hsmParams.length > 0 && (
                          <div>
                            <label className="text-xs text-slate-500 block mb-1">Preview</label>
                            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs whitespace-pre-wrap">
                              {renderHsm(t.content, hsmParams)}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => setHsmOpen(false)}
                      disabled={hsmBusy}
                      className="px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40"
                    >Batal</button>
                    <button
                      onClick={sendHsm}
                      disabled={hsmBusy || !hsmName}
                      className="px-4 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-40"
                    >{hsmBusy ? 'Mengirim…' : 'Kirim HSM'}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Profile drawer backdrop (mobile only) */}
        {profileOpen && (
          <button
            type="button"
            aria-label="Tutup profil"
            onClick={() => setProfileOpen(false)}
            className="lg:hidden fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm"
          />
        )}

        {/* Sidebar (in-place on lg, slide-over on mobile) */}
<div
          className={`
            space-y-3 overflow-y-auto bg-slate-50
            lg:static lg:translate-x-0 lg:bg-transparent lg:block lg:max-w-none lg:w-auto
            lg:min-h-0 lg:h-full
            fixed top-0 right-0 bottom-0 z-40 w-[88vw] max-w-[360px] shadow-2xl
            transition-transform duration-200 ease-out
            ${profileOpen ? 'translate-x-0' : 'translate-x-full'}
            lg:!translate-x-0
          `}
        >
          {/* Mobile drawer header */}
          <div className="lg:hidden sticky top-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between z-10">
            <div className="font-semibold text-sm text-slate-800">Profil Customer</div>
            <button
              onClick={() => setProfileOpen(false)}
              aria-label="Tutup"
              className="w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
            >✕</button>
          </div>

          <div className="p-3 lg:p-0 space-y-3">
          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <div className="text-xs text-slate-500 mb-1">Customer</div>
            <div className="font-semibold text-sm">{contact?.cust_name || '—'}</div>
            <div className="text-sm text-slate-600">{formatPhone(contact?.cust_number)}</div>
            <div className="text-xs text-slate-500 mt-1">
              {contact?.city_name && <>📍 {contact.city_name} · </>}
              {contact?.label && <>🏷 {contact.label} · </>}
              {contact?.lead_product && <>💐 {contact.lead_product}</>}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Inbound terakhir: {formatRelative(contact?.last_inbound_at) || '—'}
            </div>
            {contact?.lotus_assigned_to && (
              <div className="text-xs text-slate-500">
                Lotus assignee: {contact.lotus_assigned_to}
              </div>
            )}
          </div>

          {/* POS customer link (MySQL) */}
          {custInfo.isLoading && !custInfo.data && (
            <div className="bg-white rounded-lg border border-slate-200 p-3 text-xs text-slate-400">
              Mencari di database customer…
            </div>
          )}
          {custInfo.data && !custInfo.data.customer && (
            <div className="bg-white rounded-lg border border-slate-200 p-3 text-xs text-slate-500">
              <div className="font-semibold text-slate-700 mb-0.5">POS Customer</div>
              Nomor ini belum terdaftar di database POS Prestisa.
            </div>
          )}
          {custInfo.data?.customer && (() => {
            const cust = custInfo.data.customer;
            const stats = custInfo.data.stats || {};
            const owner = cust.owner;
            const active = custInfo.data.active || [];
            const completed = custInfo.data.completed || [];
            const fmtIDR = (n) => n == null ? '—' : 'Rp ' + Number(n).toLocaleString('id-ID');
            const fmtDate = (d) => d ? new Date(d).toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' }) : '—';
            return (
              <>
                {/* POS profile + owner */}
                <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-slate-500">POS Customer</div>
                    <span className="text-[10px] font-mono text-slate-400">#{cust.id}</span>
                  </div>
                  <div className="font-semibold text-sm text-slate-800">{cust.name || '—'}</div>
                  {cust.email && <div className="text-xs text-slate-600 truncate">{cust.email}</div>}
                  {cust.address && <div className="text-[11px] text-slate-500 line-clamp-2">{cust.address}</div>}
                  <div className="flex flex-wrap gap-1 pt-1">
                    {cust.is_member && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200">
                        ⭐ Member {cust.member_since ? `sejak ${fmtDate(cust.member_since)}` : ''}
                      </span>
                    )}
                    {cust.label && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200">
                        {cust.label}
                      </span>
                    )}
                    {cust.status && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                        {cust.status}
                      </span>
                    )}
                  </div>
                  {/* Sales owner */}
                  <div className="pt-2 mt-1 border-t border-slate-100">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">Sales Owner</div>
                    {owner ? (
                      <div className="mt-1">
                        <div className="text-sm font-semibold text-slate-800">{owner.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {owner.dept && <span>{owner.dept}</span>}
                          {owner.email && <span> · {owner.email}</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-400 italic mt-0.5">Belum di-assign</div>
                    )}
                  </div>
                  {/* Stats */}
                  {stats.total_orders > 0 && (
                    <div className="pt-2 mt-1 border-t border-slate-100 grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <div className="text-slate-400">Total Order</div>
                        <div className="font-semibold text-slate-800">{stats.total_orders}×</div>
                      </div>
                      <div>
                        <div className="text-slate-400">LTV</div>
                        <div className="font-semibold text-slate-800">{fmtIDR(stats.lifetime_value)}</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Active orders */}
                {active.length > 0 && (
                  <div className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="text-xs text-slate-500 mb-2 flex items-center gap-1.5">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Order Aktif ({active.length})
                      <span className="text-[10px] text-slate-400 ml-auto">tap untuk detail →</span>
                    </div>
                    <div className="space-y-2">
                      {active.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => setOrderDetailId(o.id)}
                          className="w-full text-left border border-slate-200 rounded-md p-2 text-[12px] hover:bg-violet-50 hover:border-violet-300 active:bg-violet-100 transition"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] text-slate-700">{o.order_number}</span>
                            <span className="font-semibold text-slate-800">{fmtIDR(o.total)}</span>
                          </div>
                          {o.items_summary && (
                            <div className="text-[11px] text-slate-600 line-clamp-2 mt-0.5">{o.items_summary}</div>
                          )}
                          <div className="flex items-center justify-between mt-1 text-[10px] text-slate-500">
                            <span>
                              {o.payment_status && (
                                <span className={`px-1.5 py-0.5 rounded ${
                                  o.payment_status === 'paid' ? 'bg-emerald-50 text-emerald-700' :
                                  o.payment_status === 'unpaid' ? 'bg-amber-50 text-amber-700' :
                                  'bg-slate-100 text-slate-600'
                                }`}>{o.payment_status}</span>
                              )}
                            </span>
                            <span>
                              {o.min_delivery_date && <>📅 {fmtDate(o.min_delivery_date)}</>}
                              {o.order_owner_name && <> · {o.order_owner_name}</>}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Last 3 completed */}
                {completed.length > 0 && (
                  <div className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="text-xs text-slate-500 mb-2">3 Order Terakhir (selesai)</div>
                    <div className="space-y-1.5">
                      {completed.map((o) => (
                        <div key={o.id} className="flex items-center justify-between py-1 border-b border-slate-100 last:border-b-0 text-[12px]">
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-[11px] text-slate-700">{o.order_number}</div>
                            {o.items_summary && (
                              <div className="text-[10px] text-slate-500 truncate">{o.items_summary}</div>
                            )}
                            <div className="text-[10px] text-slate-400">
                              {fmtDate(o.created_at)}
                              {o.order_owner_name && <> · {o.order_owner_name}</>}
                            </div>
                          </div>
                          <div className="text-right ml-2 flex-shrink-0">
                            <div className="font-semibold text-slate-800 text-[12px]">{fmtIDR(o.total)}</div>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">✓ selesai</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
            <div className="text-xs text-slate-500">CRM state</div>
            <div className="flex flex-wrap gap-1.5">
              <button
                disabled={busy}
                onClick={() => callAction('/assign', { staff_id: 'me' })}
                className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >Assign me</button>
              <button
                disabled={busy}
                onClick={() => callAction('/takeover')}
                className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >Takeover 24h</button>
              <button
                disabled={busy}
                onClick={() => {
                  const h = parseInt(prompt('Snooze berapa jam? (1-720)', '12'));
                  if (h && h >= 1 && h <= 720) callAction('/snooze', { hours: h });
                }}
                className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >Snooze…</button>
              <button
                disabled={busy}
                onClick={() => callAction(state.status === 'closed' ? '/reopen' : '/close')}
                className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >{state.status === 'closed' ? 'Reopen' : 'Close'}</button>
              <button
                disabled={busy}
                onClick={() => callAction('/shadow', { enabled: !state.shadow_mode })}
                className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
              >Shadow: {state.shadow_mode ? 'on' : 'off'}</button>
            </div>
            <div className="text-[11px] text-slate-500">
              Status: <b>{state.status || 'active'}</b>
              {state.assigned_staff_id && <> · assigned #{state.assigned_staff_id}</>}
              {state.snoozed_until && <> · snoozed sampai {formatRelative(state.snoozed_until)}</>}
              {state.ai_paused_until && <> · AI paused sampai {formatRelative(state.ai_paused_until)}</>}
            </div>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-slate-500">AI Summary</div>
              <button
                onClick={doSummary}
                disabled={summarizing}
                className="px-2 py-0.5 text-xs border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40"
              >{summarizing ? '…' : 'Generate'}</button>
            </div>
            <div className="text-xs text-slate-700 whitespace-pre-wrap">
              {summary || state.ai_summary || <span className="text-slate-400">Belum ada ringkasan.</span>}
            </div>
            {state.ai_summary_generated_at && (
              <div className="text-[10px] text-slate-400 mt-1">
                {formatRelative(state.ai_summary_generated_at)} · {state.ai_summary_msg_count} pesan
              </div>
            )}
          </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
