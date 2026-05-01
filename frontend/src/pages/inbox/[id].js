import { useRouter } from 'next/router';
import { useState, useCallback, useRef } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import ChatThread from '@/components/ChatThread';
import HandoverBanner from '@/components/HandoverBanner';
import CustomerPanel from '@/components/CustomerPanel';
import { api, fetcher } from '@/lib/api';
import { useSocket } from '@/lib/useSocket';
import { useToast } from '@/components/Toast';
import { convStatusLabel, formatRelative, formatPhone } from '@/lib/format';

export default function ChatDetail() {
  const router = useRouter();
  const id = router.query.id;
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const fileInputRef = useRef(null);

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
      await api(`/api/inbox/conversations/${id}/send`, { method: 'POST', body: { body } });
      setDraft('');
      // Live event will append the message; also revalidate as a backstop
      messages.mutate();
    } catch (err) {
      toast.error(err.message || 'Gagal kirim');
    } finally {
      setSending(false);
    }
  }, [draft, id, messages, toast]);

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
        const tools = (r.tools_used || []).map((t) => t.name).join(', ');
        toast.success(tools ? `Saran AI siap (tools: ${tools})` : 'Saran AI siap');
      }
    } catch (err) {
      toast.error('Suggest gagal: ' + err.message);
    } finally {
      setSuggesting(false);
    }
  }, [id, toast]);

  const summarizeChat = useCallback(async () => {
    setSummaryLoading(true);
    setSummary(null);
    try {
      const r = await api(`/api/inbox/conversations/${id}/ai-summary`, { method: 'POST' });
      setSummary({ text: r.summary, count: r.message_count, at: new Date().toISOString() });
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
  const status = convData ? convStatusLabel(convData) : null;
  const isPaused = convData?.ai_paused_until && new Date(convData.ai_paused_until) > new Date();

  return (
    <Layout title={`Chat ${convData?.phone || ''} — Tiara`}>
      <div className="max-w-7xl mx-auto h-[calc(100vh-57px)] flex">
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

              {/* Desktop: all secondary actions inline */}
              <div className="hidden sm:flex items-center gap-2">
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

        {/* Composer */}
        <form
          onSubmit={sendReply}
          className="bg-white border-t border-slate-200 px-3 sm:px-4 py-3"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
            className="hidden"
            onChange={handleFilePick}
          />

          {/* Mobile-first: stacked rows. sm+: textarea + vertical action stack on right */}
          <div className="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              placeholder="Ketik balasan operator…"
              rows={2}
              className="flex-1 resize-none border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-brand-500 min-h-[60px]"
            />

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

        {/* Right sidebar: customer profile */}
        <div className="hidden lg:block">
          <CustomerPanel convId={id} />
        </div>
      </div>
    </Layout>
  );
}
