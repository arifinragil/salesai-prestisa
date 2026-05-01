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
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <button
              onClick={() => router.push('/inbox')}
              className="text-xs text-slate-500 hover:text-slate-700 mb-1"
            >
              ← Kembali ke inbox
            </button>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-800">
                {convData ? formatPhone(convData.phone) : id}
              </span>
              {convData?.phone?.endsWith?.('@lid') && (
                <span className="text-xs text-slate-400" title={convData.phone}>
                  (LID — nomor asli tidak terdeteksi)
                </span>
              )}
              {status && <span className={`status-pill ${status.cls}`}>{status.label}</span>}
              {convData?.last_intent && (
                <span className="text-xs text-slate-400">· {convData.last_intent}</span>
              )}
            </div>
            <div className="text-xs text-slate-400">
              {convData?.customer_id ? `Customer #${convData.customer_id}` : 'Belum terhubung ke akun'}
              {convData?.assigned_staff_id && ` · assigned ${convData.assigned_staff_id}`}
              {convData?.last_message_at && ` · ${formatRelative(convData.last_message_at)}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={summarizeChat}
              disabled={summaryLoading}
              className="text-xs px-3 py-1.5 rounded-md text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50"
              title="Ringkasan AI"
            >
              {summaryLoading ? '…' : '📋 Summary'}
            </button>
            {isPaused ? (
              <button
                onClick={() => callAction('/resume-ai', 'Resume AI')}
                className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600"
              >
                Resume AI
              </button>
            ) : (
              <button
                onClick={() => callAction('/takeover', 'Takeover')}
                className="text-sm px-3 py-1.5 rounded-md bg-amber-500 text-white hover:bg-amber-600"
              >
                Takeover
              </button>
            )}
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={!!convData?.shadow_mode}
                onChange={(e) => setShadow(e.target.checked)}
              />
              Shadow
            </label>
            {convData?.status === 'closed' ? (
              <button
                onClick={() => callAction('/reopen', 'Reopen')}
                className="text-xs px-3 py-1.5 rounded-md text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 border border-emerald-200"
              >
                Reopen
              </button>
            ) : (
              <button
                onClick={() => callAction('/close', 'Tutup')}
                className="text-xs px-3 py-1.5 rounded-md text-slate-500 hover:text-rose-600 hover:bg-rose-50"
              >
                Close
              </button>
            )}
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
          className="bg-white border-t border-slate-200 px-4 py-3"
        >
          <div className="flex items-end gap-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  sendReply();
                }
              }}
              placeholder="Ketik balasan operator… (Ctrl/⌘+Enter untuk kirim)"
              rows={2}
              className="flex-1 resize-none border border-slate-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-brand-500"
            />
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
                className="hidden"
                onChange={handleFilePick}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="text-xs px-3 py-1.5 rounded-md text-slate-700 border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                title="Kirim foto atau dokumen (caption pakai isi composer)"
              >
                {uploading ? '…' : '📎 File'}
              </button>
              <button
                type="button"
                onClick={suggestReply}
                disabled={suggesting}
                className="text-xs px-3 py-1.5 rounded-md text-brand-700 border border-brand-200 bg-brand-50 hover:bg-brand-100 disabled:opacity-50 whitespace-nowrap"
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
