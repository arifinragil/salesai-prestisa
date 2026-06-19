import { useEffect, useMemo, useRef, useState } from 'react';
import Layout from '@/components/Layout';
import { api } from '@/lib/api';

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function StatusPill({ status }) {
  const isOpen = status === 'open';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${
        isOpen
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {isOpen ? 'Open' : 'Closed'}
    </span>
  );
}

export default function CustomerIssuesPage() {
  const [statusFilter, setStatusFilter] = useState('open');
  const [issues, setIssues] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');

  const [activeId, setActiveId] = useState(null);
  const [issue, setIssue] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const scrollRef = useRef(null);

  async function refreshList() {
    setLoadingList(true);
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set('status', statusFilter);
      const data = await api(`/api/customer-issues?${qs.toString()}`);
      setIssues(data?.issues || []);
    } catch (e) {
      setError(e.message || 'Gagal memuat daftar.');
    } finally {
      setLoadingList(false);
    }
  }

  async function openIssue(id) {
    setActiveId(id);
    setLoadingThread(true);
    setError('');
    try {
      const data = await api(`/api/customer-issues/${id}`);
      setIssue(data?.issue || null);
      setMessages(data?.messages || []);
    } catch (e) {
      setError(e.message || 'Gagal memuat percakapan.');
    } finally {
      setLoadingThread(false);
    }
  }

  async function send() {
    if (!activeId || !draft.trim()) return;
    setSending(true);
    setError('');
    try {
      const data = await api(`/api/customer-issues/${activeId}`, {
        method: 'POST',
        body: { message: draft },
      });
      setMessages((prev) => [...prev, data.message]);
      setDraft('');
      refreshList();
    } catch (e) {
      setError(e.message || 'Gagal mengirim.');
    } finally {
      setSending(false);
    }
  }

  async function toggleStatus() {
    if (!issue) return;
    const next = issue.status === 'open' ? 'closed' : 'open';
    try {
      await api(`/api/customer-issues/${issue.id}`, {
        method: 'PATCH',
        body: { status: next },
      });
      setIssue({ ...issue, status: next });
      refreshList();
    } catch (e) {
      setError(e.message || 'Gagal update status.');
    }
  }

  // Initial + when filter changes
  useEffect(() => {
    refreshList();
    const t = setInterval(refreshList, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Auto-scroll thread to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(
      (i) =>
        (i.orderNumber || '').toLowerCase().includes(q) ||
        (i.customerEmail || '').toLowerCase().includes(q) ||
        (i.customerName || '').toLowerCase().includes(q) ||
        (i.lastBody || '').toLowerCase().includes(q)
    );
  }, [issues, search]);

  return (
    <Layout title="Customer · Tiara CRM">
      <div className="h-full flex flex-col md:flex-row min-h-0">
        {/* List */}
        <aside className={`md:w-96 lg:w-[420px] border-r border-slate-200 bg-white flex flex-col min-h-0 ${activeId ? 'hidden md:flex' : 'flex'}`}>
          <div className="p-3 border-b border-slate-200 space-y-2">
            <div className="flex items-center gap-2">
              <h1 className="font-semibold text-slate-800 text-sm flex-1">Isu Customer</h1>
              <button
                onClick={refreshList}
                className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1 rounded hover:bg-slate-100"
                title="Refresh"
              >
                ↻
              </button>
            </div>
            <div className="flex gap-1 text-xs">
              {['open', 'closed', ''].map((s) => (
                <button
                  key={s || 'all'}
                  onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1 rounded-md border ${
                    statusFilter === s
                      ? 'bg-brand-50 text-brand-700 border-brand-200 font-medium'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : 'Semua'}
                </button>
              ))}
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari order, email, atau pesan…"
              className="w-full h-9 px-3 text-sm border border-slate-200 rounded-md bg-slate-50 focus:outline-none focus:ring-1 focus:ring-brand-300"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <p className="p-6 text-center text-sm text-slate-400">Memuat…</p>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-400">Tidak ada isu.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filtered.map((i) => (
                  <li key={i.id}>
                    <button
                      onClick={() => openIssue(i.id)}
                      className={`w-full text-left px-3 py-2.5 transition-colors ${
                        activeId === i.id ? 'bg-brand-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="font-mono text-[11px] text-slate-700 truncate">
                          {i.orderNumber}
                        </span>
                        <StatusPill status={i.status} />
                      </div>
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {i.customerName || i.customerEmail}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {i.lastSenderRole === 'crm' ? 'Anda: ' : ''}
                        {i.lastBody || '—'}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {fmtTime(i.lastMessageAt)} · {i.messageCount} pesan
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Thread */}
        <section className={`flex-1 flex flex-col min-h-0 bg-slate-50 ${activeId ? 'flex' : 'hidden md:flex'}`}>
          {!activeId ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Pilih isu di kiri untuk melihat percakapan.
            </div>
          ) : (
            <>
              <header className="bg-white border-b border-slate-200 px-3 sm:px-4 py-2.5 flex items-center gap-2">
                <button
                  onClick={() => setActiveId(null)}
                  className="md:hidden w-9 h-9 inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                  aria-label="Kembali"
                >
                  ←
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {issue?.subject || 'Isu Order'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {issue?.customerName || issue?.customerEmail}
                    {issue?.customerEmail ? ` · ${issue.customerEmail}` : ''}
                  </p>
                </div>
                {issue && (
                  <button
                    onClick={toggleStatus}
                    className={`text-xs px-3 py-1.5 rounded-md border ${
                      issue.status === 'open'
                        ? 'border-slate-300 text-slate-700 hover:bg-slate-100'
                        : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    {issue.status === 'open' ? 'Tutup Isu' : 'Buka Lagi'}
                  </button>
                )}
              </header>

              <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-3">
                {loadingThread ? (
                  <p className="text-center text-sm text-slate-400 py-8">Memuat…</p>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-slate-400 py-8">Belum ada pesan.</p>
                ) : (
                  messages.map((m) => {
                    const mine = m.senderRole === 'crm';
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                            mine
                              ? 'bg-brand-600 text-white rounded-br-md'
                              : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'
                          }`}
                          style={mine ? { background: '#7c3aed' } : undefined}
                        >
                          <p className={`text-[11px] font-semibold mb-0.5 ${mine ? 'text-white/80' : 'text-emerald-700'}`}>
                            {m.senderName || (mine ? 'CRM' : 'Customer')}
                          </p>
                          {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                          {m.attachmentUrl && (
                            m.attachmentType && m.attachmentType.startsWith('image/') ? (
                              <a href={m.attachmentUrl} target="_blank" rel="noreferrer" className="block mt-1">
                                <img src={m.attachmentUrl} alt={m.attachmentName || 'gambar'} className="max-w-[200px] max-h-48 rounded-lg object-cover border border-black/10" />
                              </a>
                            ) : (
                              <a href={m.attachmentUrl} target="_blank" rel="noreferrer"
                                className={`mt-1 flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs ${mine ? 'bg-white/20' : 'bg-slate-100 border border-slate-200'}`}>
                                📎 <span className="truncate max-w-[180px]">{m.attachmentName || 'Dokumen'}</span>
                              </a>
                            )
                          )}
                          <p className={`text-[10px] mt-0.5 ${mine ? 'text-white/70' : 'text-slate-400'}`}>
                            {fmtTime(m.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="border-t border-slate-200 bg-white p-3">
                {error && <p className="text-xs text-rose-600 mb-2">{error}</p>}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Tulis balasan…"
                    rows={2}
                    className="flex-1 resize-none px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-300 bg-slate-50"
                  />
                  <button
                    onClick={send}
                    disabled={sending || !draft.trim()}
                    className="h-11 px-4 inline-flex items-center justify-center rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                  >
                    {sending ? '…' : 'Kirim'}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </Layout>
  );
}
