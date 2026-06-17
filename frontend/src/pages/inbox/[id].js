import { useRouter } from 'next/router';
import { useState, useCallback, useRef, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import Layout from '@/components/Layout';
import ChatThread from '@/components/ChatThread';
import HandoverBanner from '@/components/HandoverBanner';
import CustomerPanel from '@/components/CustomerPanel';
import { api, fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useToast } from '@/components/Toast';
import { convStatusLabel, formatRelative, formatPhone } from '@/lib/format';
import PipelineStageBadge from '@/components/PipelineStageBadge';
import CoPilotPanel from '@/components/CoPilotPanel';
import LeadTempBadge from '@/components/LeadTempBadge';

export default function ChatDetail() {
  const router = useRouter();
  const id = router.query.id;
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [aiOriginal, setAiOriginal] = useState(null); // last AI-suggested or AI-rewritten text
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSending, setCatalogSending] = useState(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplFilter, setTplFilter] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState(null);
  const [chipsOpen, setChipsOpen] = useState(false);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  // Redirect into the Lotus chat. Nearly every WAHA conversation is mirrored
  // from Lotus (crm_conversations.lotus_id, ~99.98% populated), and the Lotus
  // inbox is now the primary surface. Resolve conversation_id → lotus_id and
  // router.replace into /lotus-inbox/<lotus_id>. The rare unmirrored conv
  // (lotus_id null) or a lookup failure falls back to this legacy detail page.
  const [redirectState, setRedirectState] = useState('pending'); // pending | redirecting | legacy
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setRedirectState('pending');
    api(`/api/inbox/conversations/${id}/lotus-id`)
      .then((r) => {
        if (cancelled) return;
        if (r?.lotus_id) {
          setRedirectState('redirecting');
          router.replace(`/lotus-inbox/${encodeURIComponent(r.lotus_id)}`);
        } else {
          setRedirectState('legacy');
        }
      })
      .catch(() => { if (!cancelled) setRedirectState('legacy'); });
    return () => { cancelled = true; };
  }, [id, router]);

  const { data: tplData } = useSWR('/api/ops/reply-templates', fetcher);
  const { data: snipData } = useSWR('/api/users/me/snippets', fetcher);
  const settingsData = useSWR('/api/admin/settings', fetcher, { revalidateOnFocus: false, refreshInterval: 60_000 });
  const aiMode = (settingsData.data?.items || []).find((s) => s.key === 'ai_mode')?.value || 'auto';
  const allTemplates = [
    ...((snipData?.items || []).map((s) => ({ ...s, scope: 'me', category: 'pribadi' }))),
    ...(tplData?.items || []).map((t) => ({ ...t, scope: 'global' })),
  ];
  const quickChips = allTemplates.slice(0, 8);

  const conv = useSWR(id ? `/api/inbox/conversations` : null, fetcher, { refreshInterval: 0 });
  const me = useSWR('/api/auth/me', fetcher, { revalidateOnFocus: false, shouldRetryOnError: false });
  const messages = useSWR(
    id ? `/api/inbox/conversations/${id}/messages` : null,
    fetcher,
    { refreshInterval: 0 }
  );
  const handovers = useSWR(
    id ? `/api/inbox/handovers?open=true` : null,
    fetcher,
    { refreshInterval: 30_000 }
  );
  const claim = useSWR(
    id ? `/api/users/conversations/${id}/claim` : null,
    fetcher,
    { refreshInterval: 30_000 }
  );
  const onlineUsers = useSWR('/api/users/online', fetcher, { refreshInterval: 30_000 });

  // Live message append on Socket.IO event
  useSocket(
    {
      'crm:message': (payload) => {
        if (String(payload.conversation_id) !== String(id)) return;
        messages.mutate((prev) => {
          if (!prev) return prev;
          // dedupe by id
          if (prev.messages.some((m) => String(m.id) === String(payload.message.id))) return prev;
          return { ...prev, messages: [...prev.messages, payload.message] };
        }, false);
      },
      'crm:conv-updated': (payload) => {
        if (String(payload.conversation_id) === String(id)) {
          conv.mutate();
        }
      },
      'crm:handover': () => handovers.mutate(),
    },
    { joinRooms: id ? [{ event: 'crm:join-conv', arg: parseInt(id, 10) }] : [] }
  );

  const convData = (conv.data?.items || []).find((c) => String(c.id) === String(id));
  const convHandovers = (handovers.data?.items || []).filter((h) => String(h.conversation_id) === String(id));

  const sendReply = useCallback(async (e) => {
    e?.preventDefault?.();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const result = await api(`/api/inbox/conversations/${id}/send`, { method: 'POST', body: { body } });
      // Log AI correction (existing flow for /ai-suggest-reply)
      if (aiOriginal && aiOriginal !== body) {
        api('/api/ops/ai-corrections', {
          method: 'POST',
          body: { conversation_id: id, ai_suggested: aiOriginal, operator_sent: body },
        }).catch(() => {});
      }
      // Log copilot suggestion usage
      if (pendingSuggestion) {
        api(`/api/inbox/conversations/${id}/suggestions/${pendingSuggestion.logId}/use`, {
          method: 'POST',
          body: {
            picked_rank: pendingSuggestion.rank,
            sent_text: body,
            sent_msg_id: result?.message_id || null,
          },
        }).catch(() => {});
        setPendingSuggestion(null);
      } else if (aiMode === 'copilot') {
        // Manual reply (no Use clicked) — mark latest suggestion as 'manual'
        try {
          const latest = await fetcher(`/api/inbox/conversations/${id}/suggestions/latest`);
          if (latest?.suggestion?.id && !latest.suggestion.usage_type) {
            api(`/api/inbox/conversations/${id}/suggestions/${latest.suggestion.id}/use`, {
              method: 'POST',
              body: {
                picked_rank: null,
                sent_text: body,
                sent_msg_id: result?.message_id || null,
              },
            }).catch(() => {});
          }
        } catch {}
      }
      setAiOriginal(null);
      setDraft('');
      messages.mutate();
    } catch (err) {
      toast.error(err.message || 'Gagal kirim');
    } finally {
      setSending(false);
    }
  }, [draft, id, messages, toast, aiOriginal, pendingSuggestion, aiMode]);

  const callAction = useCallback(async (path, label) => {
    try {
      await api(`/api/inbox/conversations/${id}${path}`, { method: 'POST' });
      toast.success(label + ' berhasil');
      conv.mutate();
    } catch (err) {
      toast.error(err.message || 'Gagal');
    }
  }, [id, conv, toast]);

  const suggestReply = useCallback(async () => {
    setSuggesting(true);
    try {
      const r = await api(`/api/inbox/conversations/${id}/ai-suggest-reply`, { method: 'POST' });
      const text = (r.reply || '').trim();
      if (!text) {
        toast.error('AI tidak menghasilkan saran');
      } else {
        setDraft(text);
        setAiOriginal(text);
        const tools = (r.tools_used || []).map((t) => t.name).join(', ');
        toast.success(tools ? `Saran AI siap (tools: ${tools})` : 'Saran AI siap');
      }
    } catch (err) {
      toast.error('Suggest gagal: ' + err.message);
    } finally {
      setSuggesting(false);
    }
  }, [id, toast]);

  const rewriteDraft = useCallback(async (tone = 'sopan') => {
    const body = draft.trim();
    if (!body) { toast.error('Tulis draft dulu'); return; }
    setRewriting(true);
    try {
      const r = await api(`/api/inbox/conversations/${id}/rewrite`, { method: 'POST', body: { draft: body, tone } });
      const text = (r.rewritten || '').trim();
      if (!text) toast.error('AI tidak menghasilkan revisi');
      else { setDraft(text); setAiOriginal(text); toast.success('Draft diperhalus'); }
    } catch (err) { toast.error('Rewrite gagal: ' + err.message); }
    finally { setRewriting(false); }
  }, [draft, id, toast]);

  const doSnooze = useCallback(async (hours) => {
    setSnoozeOpen(false);
    try {
      await api(`/api/inbox/conversations/${id}/snooze`, { method: 'POST', body: { hours } });
      toast.success(`Snooze ${hours}j`);
      conv.mutate();
    } catch (err) { toast.error('Snooze gagal: ' + err.message); }
  }, [id, conv, toast]);

  const sendProduct = useCallback(async (productId) => {
    setCatalogSending(productId);
    try {
      await api(`/api/inbox/conversations/${id}/send-product`, { method: 'POST', body: { product_id: productId } });
      toast.success('Produk dikirim');
      messages.mutate();
      setCatalogOpen(false);
    } catch (err) { toast.error('Gagal kirim produk: ' + err.message); }
    finally { setCatalogSending(null); }
  }, [id, messages, toast]);

  const doClaim = useCallback(async () => {
    try {
      await api(`/api/users/conversations/${id}/claim`, { method: 'POST' });
      toast.success('Conv di-claim');
      claim.mutate();
    } catch (err) {
      toast.error(err.message);
      claim.mutate();
    }
  }, [id, claim, toast]);

  const doRelease = useCallback(async () => {
    try {
      await api(`/api/users/conversations/${id}/release`, { method: 'POST' });
      toast.success('Claim dilepas');
      claim.mutate();
    } catch (err) { toast.error(err.message); }
  }, [id, claim, toast]);

  const doUnsnooze = useCallback(async () => {
    try {
      await api(`/api/inbox/conversations/${id}/unsnooze`, { method: 'POST' });
      toast.success('Snooze dibuka');
      conv.mutate();
    } catch (err) { toast.error(err.message); }
  }, [id, conv, toast]);

  const summarizeChat = useCallback(async () => {
    setSummaryLoading(true);
    setSummary(null);
    try {
      const r = await api(`/api/inbox/conversations/${id}/ai-summary`, { method: 'POST' });
      setSummary({ text: r.summary, count: r.message_count, at: r.generated_at || new Date().toISOString() });
      mutate(`/api/inbox/conversations/${id}/customer`);
    } catch (err) {
      toast.error('Summary gagal: ' + err.message);
    } finally {
      setSummaryLoading(false);
    }
  }, [id, toast]);

  const handleFilePick = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // allow re-pick same file later
    if (file.size > 25 * 1024 * 1024) {
      toast.error('File terlalu besar (max 25 MB)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (draft.trim()) fd.append('caption', draft.trim());
      const res = await fetch(`/api/inbox/conversations/${id}/send-file`, {
        method: 'POST', credentials: 'include', body: fd,
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || `HTTP ${res.status}`);
      toast.success(`Terkirim: ${file.name} (${data.type})`);
      setDraft('');
      messages.mutate();
    } catch (err) {
      toast.error('Upload gagal: ' + err.message);
    } finally {
      setUploading(false);
    }
  }, [id, draft, messages, toast]);

  const setShadow = useCallback(async (enabled) => {
    try {
      await api(`/api/inbox/conversations/${id}/shadow`, {
        method: 'POST', body: { enabled },
      });
      toast.success('Shadow mode ' + (enabled ? 'ON' : 'OFF'));
      conv.mutate();
    } catch (err) { toast.error(err.message); }
  }, [id, conv, toast]);

  if (!id) return null;
  // While resolving lotus_id (or mid-redirect), show a light loader instead of
  // flashing the legacy chat. Only the rare unmirrored conv renders below.
  if (redirectState !== 'legacy') {
    return (
      <Layout title="Membuka chat…">
        <div className="h-full flex items-center justify-center text-sm text-slate-400">
          Membuka chat di Lotus…
        </div>
      </Layout>
    );
  }
  const status = convData ? convStatusLabel(convData) : null;
  const isPaused = convData?.ai_paused_until && new Date(convData.ai_paused_until) > new Date();
  const isSnoozed = convData?.snoozed_until && new Date(convData.snoozed_until) > new Date();

  return (
    <Layout title={`Chat ${convData?.phone || ''} — Tiara`}>
      <div className="max-w-7xl mx-auto h-full flex">
        <div className="flex-1 min-w-0 flex flex-col">
        {/* Header — stacked on mobile (identity row + action row), inline on sm+ */}
        <div className="bg-white border-b border-slate-200 px-3 sm:px-6 py-3">
          {/* Back link — own row, always */}
          <button
            onClick={() => router.push('/inbox')}
            className="text-xs text-slate-500 hover:text-slate-700 mb-2 -ml-1 px-1 py-0.5 rounded hover:bg-slate-50 inline-flex items-center"
            aria-label="Kembali ke inbox"
          >
            ← Kembali
          </button>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            {/* Identity */}
            <div className="min-w-0 sm:flex-1">
              <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                <span className="font-semibold text-slate-800 text-sm sm:text-base break-all">
                  {convData ? formatPhone(convData.real_phone || convData.phone) : id}
                </span>
                {status && <span className={`status-pill ${status.cls}`}>{status.label}</span>}
                {convData?.phone?.endsWith?.('@lid') && !convData?.real_phone && (
                  <span className="text-[10px] text-amber-600 bg-amber-50 px-1 rounded border border-amber-200" title={convData.phone}>
                    LID — set nomor di sidebar
                  </span>
                )}
                {convData?.last_intent && (
                  <span className="text-[10px] text-slate-400 hidden sm:inline">· {convData.last_intent}</span>
                )}
                {convData?.lead_temperature && (
                  <LeadTempBadge temp={convData.lead_temperature} score={convData.lead_score} showScore size="sm" />
                )}
                {isSnoozed && (
                  <span className="text-[10px] text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200">
                    💤 snooze s/d {new Date(convData.snoozed_until).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                  </span>
                )}
                {convData?.pipeline_stage && (
                  <button
                    type="button"
                    onClick={() => router.push(`/pipeline?focus=${id}`)}
                    title={`Stage: ${convData.pipeline_stage}${convData.manual_stage_override ? ' (manual override)' : ''}`}
                    className="hover:opacity-80"
                  >
                    <PipelineStageBadge
                      stage={convData.pipeline_stage}
                      override={convData.manual_stage_override}
                      size="xs"
                    />
                  </button>
                )}
                <RevertStageButton convId={id} onRevert={() => conv.mutate()} />
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                {convData?.customer_id ? `#${convData.customer_id}` : 'belum terhubung'}
                {convData?.last_message_at && ` · ${formatRelative(convData.last_message_at)}`}
              </div>
            </div>

            {/* Actions — own row on mobile (justify-end), inline-right on sm+ */}
            <div className="flex items-center justify-end gap-2 shrink-0">
              {/* PRIMARY action — always visible */}
              {isPaused ? (
                <button
                  onClick={() => callAction('/resume-ai', 'Resume AI')}
                  className="text-sm px-4 py-2 rounded-md bg-brand-500 text-white hover:bg-brand-600 whitespace-nowrap font-medium min-h-[40px]"
                >
                  Resume AI
                </button>
              ) : (
                <button
                  onClick={() => callAction('/takeover', 'Takeover')}
                  className="text-sm px-4 py-2 rounded-md bg-amber-500 text-white hover:bg-amber-600 whitespace-nowrap font-medium min-h-[40px]"
                >
                  Takeover
                </button>
              )}

              {/* Claim status pill — shown next to primary action */}
              {claim.data?.claim ? (
                claim.data.claim.staff_id === claim.data.me ? (
                  <button
                    onClick={doRelease}
                    className="text-xs px-3 py-2 rounded-md text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 whitespace-nowrap"
                    title="Lepas claim"
                  >🔓 Anda yang handle</button>
                ) : (
                  <span
                    className="text-xs px-3 py-2 rounded-md text-amber-700 border border-amber-200 bg-amber-50 whitespace-nowrap"
                    title={`Diklaim ${new Date(claim.data.claim.claimed_at).toLocaleString('id-ID')}`}
                  >🔒 {claim.data.claim.full_name || claim.data.claim.username}</span>
                )
              ) : (
                <button
                  onClick={doClaim}
                  className="text-xs px-3 py-2 rounded-md text-slate-700 border border-slate-200 bg-white hover:bg-slate-50 whitespace-nowrap"
                  title="Claim — lain operator nggak balas conv ini"
                >🤝 Claim</button>
              )}

              {/* Desktop: all secondary actions inline */}
              <div className="hidden sm:flex items-center gap-2">
                {isSnoozed ? (
                  <button
                    onClick={doUnsnooze}
                    className="text-xs px-3 py-2 rounded-md text-indigo-700 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 whitespace-nowrap"
                    title="Buka snooze"
                  >
                    💤 Unsnooze
                  </button>
                ) : (
                  <div className="relative">
                    <button
                      onClick={() => setSnoozeOpen((v) => !v)}
                      className="text-xs px-3 py-2 rounded-md text-indigo-700 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 whitespace-nowrap"
                      title="Snooze AI auto-reply"
                    >
                      💤 Snooze
                    </button>
                    {snoozeOpen && (
                      <>
                        <button type="button" aria-label="close" onClick={() => setSnoozeOpen(false)} className="fixed inset-0 z-40 bg-transparent" />
                        <div className="absolute right-0 top-10 z-50 w-44 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
                          {[1, 4, 24, 72].map((h) => (
                            <button key={h} onClick={() => doSnooze(h)} className="block w-full text-left px-3 py-2 text-sm hover:bg-indigo-50 border-b border-slate-100 last:border-0">
                              {h < 24 ? `${h} jam` : `${h / 24} hari`}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                <button
                  onClick={summarizeChat}
                  disabled={summaryLoading}
                  className="text-xs px-3 py-2 rounded-md text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50 whitespace-nowrap"
                  title="Ringkasan AI"
                >
                  {summaryLoading ? '…' : '📋 Summary'}
                </button>
                <a
                  href={`/api/inbox/conversations/${id}/export.csv`}
                  className="text-xs px-3 py-2 rounded-md text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 whitespace-nowrap"
                  title="Download transcript (CSV)"
                  download
                >
                  ⬇ CSV
                </a>
                <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer px-2 py-2 rounded hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={!!convData?.shadow_mode}
                    onChange={(e) => setShadow(e.target.checked)}
                    className="cursor-pointer"
                  />
                  Shadow
                </label>
                {convData?.status === 'closed' ? (
                  <button
                    onClick={() => callAction('/reopen', 'Reopen')}
                    className="text-xs px-3 py-2 rounded-md text-emerald-700 hover:bg-emerald-50 border border-emerald-200 whitespace-nowrap"
                  >
                    Reopen
                  </button>
                ) : (
                  <button
                    onClick={() => callAction('/close', 'Tutup')}
                    className="text-xs px-3 py-2 rounded-md text-slate-500 hover:text-rose-600 hover:bg-rose-50 whitespace-nowrap"
                  >
                    Close
                  </button>
                )}
              </div>

              {/* Mobile: customer panel toggle (always visible) */}
              <button
                type="button"
                onClick={() => setPanelOpen(true)}
                aria-label="Buka info customer"
                className="lg:hidden w-10 h-10 inline-flex items-center justify-center rounded-md text-slate-600 border border-slate-200 bg-white hover:bg-slate-50"
                title="Info customer"
              >
                <span aria-hidden>👤</span>
              </button>

              {/* Mobile: overflow menu */}
              <div className="relative sm:hidden">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-label="Aksi lainnya"
                  aria-expanded={moreOpen}
                  className="w-10 h-10 inline-flex items-center justify-center rounded-md text-slate-600 border border-slate-200 bg-white hover:bg-slate-50"
                >
                  <span className="text-lg leading-none">⋯</span>
                </button>
                {moreOpen && (
                  <>
                    {/* Backdrop catches outside taps */}
                    <button
                      type="button"
                      aria-label="Tutup menu"
                      onClick={() => setMoreOpen(false)}
                      className="fixed inset-0 z-40 bg-transparent cursor-default"
                    />
                    <div
                      role="menu"
                      className="absolute right-0 top-12 z-50 w-56 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
                    >
                      {isSnoozed ? (
                        <button
                          role="menuitem"
                          onClick={() => { setMoreOpen(false); doUnsnooze(); }}
                          className="w-full text-left px-4 py-3 text-sm text-indigo-700 hover:bg-indigo-50"
                        >💤 Unsnooze</button>
                      ) : (
                        [1, 4, 24].map((h) => (
                          <button
                            key={h} role="menuitem"
                            onClick={() => { setMoreOpen(false); doSnooze(h); }}
                            className="w-full text-left px-4 py-3 text-sm text-indigo-700 hover:bg-indigo-50 border-b border-slate-100"
                          >💤 Snooze {h < 24 ? `${h}j` : `${h / 24}h`}</button>
                        ))
                      )}
                      <button
                        role="menuitem"
                        onClick={() => { setMoreOpen(false); summarizeChat(); }}
                        disabled={summaryLoading}
                        className="w-full text-left px-4 py-3 text-sm text-purple-700 hover:bg-purple-50 disabled:opacity-50"
                      >
                        {summaryLoading ? '… Generating' : '📋 Summary AI'}
                      </button>
                      <a
                        role="menuitem"
                        href={`/api/inbox/conversations/${id}/export.csv`}
                        download
                        onClick={() => setMoreOpen(false)}
                        className="block px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 border-t border-slate-100"
                      >
                        ⬇ Download CSV
                      </a>
                      <label className="flex items-center justify-between px-4 py-3 text-sm text-slate-700 hover:bg-slate-50 border-t border-slate-100 cursor-pointer">
                        <span>Shadow mode</span>
                        <input
                          type="checkbox"
                          checked={!!convData?.shadow_mode}
                          onChange={(e) => setShadow(e.target.checked)}
                          className="cursor-pointer w-5 h-5"
                        />
                      </label>
                      {convData?.status === 'closed' ? (
                        <button
                          role="menuitem"
                          onClick={() => { setMoreOpen(false); callAction('/reopen', 'Reopen'); }}
                          className="w-full text-left px-4 py-3 text-sm text-emerald-700 hover:bg-emerald-50 border-t border-slate-100"
                        >
                          Reopen conversation
                        </button>
                      ) : (
                        <button
                          role="menuitem"
                          onClick={() => { setMoreOpen(false); callAction('/close', 'Tutup'); }}
                          className="w-full text-left px-4 py-3 text-sm text-rose-600 hover:bg-rose-50 border-t border-slate-100"
                        >
                          Close conversation
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Handover banner */}
        <HandoverBanner handovers={convHandovers} onResolved={() => handovers.mutate()} />

        {/* AI summary panel */}
        {summary && (
          <div className="mx-4 mt-3 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-purple-800 mb-1">
                  Ringkasan AI · {summary.count} pesan
                </div>
                <div className="text-sm text-purple-900 whitespace-pre-wrap">{summary.text}</div>
              </div>
              <button
                onClick={() => setSummary(null)}
                className="text-xs text-purple-600 hover:text-purple-900"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto bg-slate-50">
          {messages.isLoading && (
            <div className="text-center text-sm text-slate-400 py-8">Loading…</div>
          )}
          {messages.error && (
            <div className="text-center text-sm text-rose-500 py-8">
              {messages.error.message || 'Gagal memuat'}
            </div>
          )}
          {messages.data && <ChatThread messages={messages.data.messages || []} />}
        </div>

        {aiMode === 'copilot' && (
          <CoPilotPanel
            conversationId={id}
            leadTemp={convData?.lead_temperature}
            onUseSuggestion={({ logId, rank, text }) => {
              setDraft(text);
              setPendingSuggestion({ logId, rank, originalText: text });
              setTimeout(() => textareaRef.current?.focus(), 0);
            }}
          />
        )}

        {/* Composer */}
        <form
          onSubmit={sendReply}
          className="bg-white border-t border-slate-200 px-3 sm:px-4 py-2"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
            className="hidden"
            onChange={handleFilePick}
          />

          {/* Quick-reply chips — collapsible (default closed; expand for 1-tap insert).
              Hint: ketik /shortcut di textarea juga buka template picker. */}
          {quickChips.length > 0 && (
            <div className={chipsOpen ? 'mb-2' : 'mb-1'}>
              <button
                type="button"
                onClick={() => setChipsOpen((v) => !v)}
                className="text-[11px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
              >
                {chipsOpen ? '▾' : '▸'} Templates ({quickChips.length})
              </button>
              {chipsOpen && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {quickChips.map((t) => (
                    <button
                      key={t.id} type="button"
                      onClick={() => setDraft((d) => (d ? d + '\n' : '') + t.body)}
                      className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 hover:bg-brand-50 hover:border-brand-200 hover:text-brand-700 whitespace-nowrap"
                      title={t.body}
                    >/{t.shortcut} · {t.title}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Mobile-first: stacked rows. sm+: textarea + vertical action stack on right */}
          <div className="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3">
            <div className="flex-1 relative">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft(v);
                  // Open template picker on leading "/" with no spaces
                  const m = v.match(/(^|\n)\/([a-z0-9_-]*)$/i);
                  if (m) { setTplOpen(true); setTplFilter(m[2].toLowerCase()); }
                  else setTplOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    sendReply();
                  }
                  if (e.key === 'Escape') setTplOpen(false);
                }}
                placeholder="Ketik balasan operator… (ketik /shortcut untuk template)"
                rows={5}
                className="w-full resize-y border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-brand-500 min-h-[140px]"
              />
              {tplOpen && allTemplates.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-white border border-slate-200 rounded-md shadow-lg max-h-60 overflow-y-auto z-10">
                  {allTemplates
                    .filter((t) => !tplFilter || t.shortcut.includes(tplFilter) || t.title.toLowerCase().includes(tplFilter))
                    .slice(0, 8)
                    .map((t) => (
                      <button
                        key={t.id} type="button"
                        onClick={() => {
                          setDraft((d) => d.replace(/(^|\n)\/[a-z0-9_-]*$/i, (m) => m.startsWith('\n') ? '\n' + t.body : t.body));
                          setTplOpen(false);
                        }}
                        className="block w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <code className="bg-slate-100 px-1.5 py-0.5 rounded">/{t.shortcut}</code>
                          <span className="font-medium text-slate-700">{t.title}</span>
                          {t.category && <span className="text-slate-400">· {t.category}</span>}
                        </div>
                        <div className="text-xs text-slate-500 line-clamp-1 mt-0.5">{t.body}</div>
                      </button>
                    ))}
                </div>
              )}
            </div>

            {/* Mobile: 3 icon-buttons in a row + send full width */}
            <div className="flex sm:hidden items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                aria-label="Kirim file atau foto"
                className="w-11 h-11 inline-flex items-center justify-center rounded-md text-slate-700 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
              >
                {uploading ? <span className="text-xs">…</span> : <span aria-hidden>📎</span>}
              </button>
              <button
                type="button"
                onClick={suggestReply}
                disabled={suggesting}
                aria-label="AI saran balasan"
                className="w-11 h-11 inline-flex items-center justify-center rounded-md text-brand-700 border border-brand-200 bg-brand-50 hover:bg-brand-100 disabled:opacity-50"
              >
                {suggesting ? <span className="text-xs">…</span> : <span aria-hidden>✨</span>}
              </button>
              <button
                type="button"
                onClick={() => rewriteDraft('sopan')}
                disabled={rewriting || !draft.trim()}
                aria-label="Perhalus draft dengan AI"
                title="Perhalus draft dengan AI"
                className="w-11 h-11 inline-flex items-center justify-center rounded-md text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50"
              >
                {rewriting ? <span className="text-xs">…</span> : <span aria-hidden>✏️</span>}
              </button>
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="flex-1 bg-brand-500 text-white text-sm font-medium h-11 rounded-md hover:bg-brand-600 disabled:opacity-50"
              >
                {sending ? '…' : 'Kirim'}
              </button>
            </div>

            {/* Desktop: vertical stack on right */}
            <div className="hidden sm:flex flex-col gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="text-xs px-3 py-2 rounded-md text-slate-700 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                title="Kirim foto atau dokumen (caption pakai isi composer)"
              >
                {uploading ? '…' : '📎 File'}
              </button>
              <button
                type="button"
                onClick={suggestReply}
                disabled={suggesting}
                className="text-xs px-3 py-2 rounded-md text-brand-700 border border-brand-200 bg-brand-50 hover:bg-brand-100 disabled:opacity-50 whitespace-nowrap"
                title="AI saran balasan (bisa diedit sebelum kirim)"
              >
                {suggesting ? '…' : '✨ AI Suggest'}
              </button>
              <button
                type="button"
                onClick={() => rewriteDraft('sopan')}
                disabled={rewriting || !draft.trim()}
                className="text-xs px-3 py-2 rounded-md text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50 whitespace-nowrap"
                title="Perhalus draft (tone sopan)"
              >
                {rewriting ? '…' : '✏️ Perhalus'}
              </button>
              <button
                type="button"
                onClick={() => setCatalogOpen(true)}
                className="text-xs px-3 py-2 rounded-md text-pink-700 border border-pink-200 bg-pink-50 hover:bg-pink-100 whitespace-nowrap"
                title="Pilih produk dari katalog & kirim ke chat"
              >
                🌷 Katalog
              </button>
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="bg-brand-500 text-white text-sm font-medium px-5 py-2 rounded-md hover:bg-brand-600 disabled:opacity-50"
              >
                {sending ? '…' : 'Kirim'}
              </button>
            </div>
          </div>

          {/* Hint text — desktop only */}
          <div className="hidden sm:block text-[11px] text-slate-400 mt-2">
            Ctrl/⌘+Enter untuk kirim
          </div>
        </form>
        {me.data?.user && (
          <div className="text-xs text-slate-400 px-4 pb-2">
            Sebagai {me.data.user.username} (operator). Pesan langsung dikirim ke WhatsApp.
          </div>
        )}
        </div>

        {/* Right sidebar: customer profile (desktop) */}
        <div className="hidden lg:block h-full">
          <CustomerPanel convId={id} />
        </div>

        {/* Catalog picker modal */}
        {catalogOpen && (
          <CatalogPicker
            query={catalogQuery}
            setQuery={setCatalogQuery}
            sending={catalogSending}
            onSend={sendProduct}
            onClose={() => setCatalogOpen(false)}
          />
        )}

        {/* Mobile/tablet: slide-in drawer */}
        {panelOpen && (
          <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Tutup info customer"
              onClick={() => setPanelOpen(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <div className="absolute right-0 top-0 bottom-0 w-[88vw] max-w-sm bg-slate-50 shadow-xl flex flex-col">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-white">
                <span className="font-semibold text-slate-800">Info customer</span>
                <button
                  onClick={() => setPanelOpen(false)}
                  aria-label="Tutup"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                >✕</button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <CustomerPanel convId={id} />
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function CatalogPicker({ query, setQuery, onSend, sending, onClose }) {
  const url = `/api/inbox/products/search?q=${encodeURIComponent(query)}`;
  const products = useSWR(url, fetcher, { dedupingInterval: 1000 });
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <span className="font-semibold text-slate-800">Pilih produk dari katalog</span>
          <button onClick={onClose} aria-label="Tutup" className="w-8 h-8 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100">✕</button>
        </div>
        <div className="px-4 py-3 border-b border-slate-100">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari nama produk / kategori (mis. papan duka, bouquet mawar)…" autoFocus
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded focus:outline-none focus:border-brand-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {products.isLoading && <div className="text-center text-sm text-slate-400 py-6">Loading…</div>}
          {products.data?.items?.length === 0 && <div className="text-center text-sm text-slate-400 py-6">Tidak ada hasil.</div>}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {(products.data?.items || []).map((p) => (
              <button
                key={p.id} type="button" onClick={() => onSend(p.id)} disabled={sending === p.id}
                className="text-left rounded-md border border-slate-200 hover:border-brand-300 hover:shadow-sm overflow-hidden bg-white disabled:opacity-50"
              >
                {p.image_url
                  ? <img src={p.image_url} alt="" className="w-full h-32 object-cover bg-slate-100" loading="lazy" />
                  : <div className="w-full h-32 bg-slate-100 flex items-center justify-center text-slate-300 text-xs">no image</div>}
                <div className="p-2">
                  <div className="text-xs font-medium text-slate-800 line-clamp-2">{p.name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{p.category}</div>
                  <div className="text-xs font-semibold text-brand-700 mt-1">Rp {Number(p.price).toLocaleString('id-ID')}</div>
                  <div className="text-[10px] text-slate-400 mt-1">{sending === p.id ? 'Mengirim…' : 'Klik untuk kirim'}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RevertStageButton({ convId, onRevert }) {
  const events = useSWR(convId ? `/api/pipeline/events?conversation_id=${convId}&limit=5` : null, fetcher);
  const items = events.data?.items || [];
  if (items.length < 2) return null;
  async function doRevert() {
    if (!confirm('Revert ke stage sebelumnya?')) return;
    try {
      await api(`/api/pipeline/conversations/${convId}/revert-stage`, { method: 'POST' });
      onRevert();
      events.mutate();
    } catch (e) { alert(e.message); }
  }
  return (
    <button onClick={doRevert}
      className="text-[10px] px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100"
      title="Revert ke stage sebelumnya">↺</button>
  );
}
