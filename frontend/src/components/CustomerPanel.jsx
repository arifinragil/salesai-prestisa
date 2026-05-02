import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { fetcher, api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRupiah, formatRelative, formatPhone } from '@/lib/format';

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

function PipelineBlock({ conv, onMutate, toast }) {
  const [showLost, setShowLost] = useState(false);
  const [lostReason, setLostReason] = useState('no_reply');
  const [lostNote, setLostNote] = useState('');
  const [valueDraft, setValueDraft] = useState('');

  if (!conv) return null;

  async function setStage(stage) {
    try {
      await api(`/api/pipeline/conversations/${conv.id}/stage`, { method: 'POST', body: { stage } });
      toast.success(`Stage: ${stage}`);
      onMutate();
    } catch (e) { toast.error(e.message); }
  }
  async function setType(type) {
    try {
      await api(`/api/pipeline/conversations/${conv.id}/type`, { method: 'POST', body: { type } });
      toast.success(`Type: ${type}`);
      onMutate();
    } catch (e) { toast.error(e.message); }
  }
  async function markLost() {
    if (lostReason === 'other_with_note' && !lostNote.trim()) {
      toast.error('Note wajib untuk other_with_note');
      return;
    }
    try {
      await api(`/api/pipeline/conversations/${conv.id}/stage`, {
        method: 'POST',
        body: { stage: 'lost', lost_reason: lostReason, lost_note: lostNote || null },
      });
      toast.success('Marked Lost');
      setShowLost(false);
      setLostNote('');
      onMutate();
    } catch (e) { toast.error(e.message); }
  }
  async function saveValue() {
    const v = parseInt(valueDraft);
    if (!v || v < 0) return toast.error('value must be positive number');
    try {
      await api(`/api/pipeline/conversations/${conv.id}/value`, { method: 'POST', body: { value_idr: v, lock: true } });
      toast.success('Deal value saved');
      setValueDraft('');
      onMutate();
    } catch (e) { toast.error(e.message); }
  }

  const STAGES = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered'];
  const TYPES = ['unknown', 'papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b'];
  const LOST_REASONS = ['no_reply', 'harga_terlalu_tinggi', 'kompetitor', 'produk_tidak_cocok', 'timing_tidak_pas', 'cancelled', 'refund_complaint', 'other_with_note'];
  const isHighValue = ['wedding', 'b2b'].includes(conv.pipeline_type);

  return (
    <section className="space-y-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Pipeline</div>
      <div className="bg-white rounded-md border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Stage</span>
          <select value={conv.pipeline_stage || 'baru'} onChange={(e) => setStage(e.target.value)}
            className="text-xs px-1 py-0.5 border border-slate-200 rounded">
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="lost">lost</option>
          </select>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Type</span>
          <select value={conv.pipeline_type || 'unknown'} onChange={(e) => setType(e.target.value)}
            className="text-xs px-1 py-0.5 border border-slate-200 rounded">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Deal value</span>
          <span className="font-medium text-slate-700">
            {conv.deal_value_idr ? `Rp ${Number(conv.deal_value_idr).toLocaleString('id-ID')}` : '—'}
            {conv.deal_value_locked && <span aria-hidden title="locked"> 🔒</span>}
          </span>
        </div>
        {isHighValue && (
          <div className="flex gap-1">
            <input value={valueDraft} onChange={(e) => setValueDraft(e.target.value)} placeholder="Manual value (Rp)"
              className="flex-1 text-xs px-1.5 py-1 border border-slate-200 rounded" type="number" />
            <button onClick={saveValue} className="text-xs px-2 py-1 rounded bg-brand-500 text-white">Set</button>
          </div>
        )}
        <button onClick={() => setShowLost(!showLost)}
          className="w-full text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50">
          {showLost ? 'Tutup' : 'Mark Lost…'}
        </button>
        {showLost && (
          <div className="space-y-1">
            <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}
              className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded">
              {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {lostReason === 'other_with_note' && (
              <textarea value={lostNote} onChange={(e) => setLostNote(e.target.value)} rows={2}
                placeholder="Note (wajib)" className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded" />
            )}
            <button onClick={markLost} className="w-full text-xs px-2 py-1 rounded bg-rose-500 text-white hover:bg-rose-600">
              Konfirmasi Lost
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function NotesBlock({ convId, toast }) {
  const { data, mutate } = useSWR(convId ? `/api/ops/conversations/${convId}/notes` : null, fetcher);
  const [val, setVal] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data) { setVal(data.notes || ''); setDirty(false); } }, [data, convId]);

  async function save() {
    if (!dirty) return;
    try {
      await api(`/api/ops/conversations/${convId}/notes`, { method: 'PUT', body: { notes: val } });
      setDirty(false); mutate();
      toast.success('Catatan tersimpan');
    } catch (err) { toast.error(err.message); }
  }
  return (
    <section>
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center justify-between">
        <span>Catatan internal</span>
        {dirty && <span className="text-amber-600 normal-case font-normal">belum tersimpan</span>}
      </div>
      <textarea
        value={val}
        onChange={(e) => { setVal(e.target.value); setDirty(true); }}
        onBlur={save}
        rows={4}
        placeholder="Catatan untuk operator lain (tidak terkirim ke customer)…"
        className="w-full text-xs px-2 py-2 border border-slate-200 rounded-md bg-white resize-y"
      />
    </section>
  );
}

function TagsBlock({ convId, toast }) {
  const [picking, setPicking] = useState(false);
  const { data: tagData } = useSWR('/api/ops/tags', fetcher);
  const { data: convTagData, mutate } = useSWR(
    convId ? `/api/ops/conversations/${convId}/tags` : null, fetcher
  );
  const allTags = tagData?.items || [];
  const selected = convTagData?.items || [];
  const selectedIds = new Set(selected.map((t) => t.id));
  const available = allTags.filter((t) => !selectedIds.has(t.id));

  async function setTags(nextIds) {
    try {
      await api(`/api/ops/conversations/${convId}/tags`, { method: 'POST', body: { tag_ids: nextIds } });
      mutate();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <section>
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Label</div>

      {/* Selected tags as removable chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selected.length === 0 && (
          <span className="text-xs text-slate-400">Belum ada label</span>
        )}
        {selected.map((t) => (
          <button
            key={t.id}
            onClick={() => setTags(Array.from(selectedIds).filter((id) => id !== t.id))}
            className={`group inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${TAG_COLOR[t.color] || TAG_COLOR.slate}`}
            title={t.auto ? 'Auto-tagged oleh AI — klik untuk lepas' : 'Klik untuk lepas'}
          >
            {t.auto && <span aria-hidden className="opacity-70">✨</span>}
            {t.name}
            <span className="opacity-50 group-hover:opacity-100">✕</span>
          </button>
        ))}
      </div>

      {/* + Add label button + popover picker */}
      {allTags.length === 0 ? (
        <a href="/tags" className="text-xs text-brand-600 hover:underline">
          + Buat label dulu di /tags
        </a>
      ) : !picking ? (
        <button
          onClick={() => setPicking(true)}
          disabled={available.length === 0}
          className="text-xs px-2.5 py-1 rounded-md border border-dashed border-slate-300 text-slate-600 hover:border-brand-400 hover:text-brand-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {available.length === 0 ? 'Semua label sudah dipasang' : '+ Tambah label'}
        </button>
      ) : (
        <div className="bg-white border border-slate-200 rounded-md p-2 space-y-1">
          {available.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTags([...selectedIds, t.id]); setPicking(false); }}
              className="block w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 text-xs"
            >
              <span className={`inline-block px-1.5 py-0.5 rounded-full border ${TAG_COLOR[t.color] || TAG_COLOR.slate}`}>
                {t.name}
              </span>
            </button>
          ))}
          <button
            onClick={() => setPicking(false)}
            className="block w-full text-center text-xs text-slate-400 hover:text-slate-600 pt-1 border-t border-slate-100"
          >
            Batal
          </button>
        </div>
      )}
    </section>
  );
}

function CsatButton({ convId, toast }) {
  const [sending, setSending] = useState(false);
  async function send() {
    if (!confirm('Kirim survey CSAT (1-5 ⭐) ke customer sekarang?')) return;
    setSending(true);
    try {
      await api(`/api/inbox/conversations/${convId}/csat-request`, { method: 'POST' });
      toast.success('CSAT prompt terkirim');
    } catch (err) { toast.error(err.message); }
    finally { setSending(false); }
  }
  return (
    <button onClick={send} disabled={sending}
      className="w-full text-xs px-3 py-2 border border-slate-200 rounded-md bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50">
      {sending ? 'Mengirim…' : '⭐ Minta CSAT'}
    </button>
  );
}

const STATUS_COLOR = {
  paid: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  unpaid: 'text-amber-700 bg-amber-50 border-amber-200',
  approved: 'text-blue-700 bg-blue-50 border-blue-200',
  unapproved: 'text-slate-600 bg-slate-50 border-slate-200',
  canceled: 'text-rose-700 bg-rose-50 border-rose-200',
  cancel: 'text-rose-700 bg-rose-50 border-rose-200',
};

function StatusPill({ s }) {
  const cls = STATUS_COLOR[s] || 'text-slate-700 bg-slate-50 border-slate-200';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border ${cls}`}>
      {s}
    </span>
  );
}

export default function CustomerPanel({ convId }) {
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR(
    convId ? `/api/inbox/conversations/${convId}/customer` : null,
    fetcher,
    { refreshInterval: 60_000 }
  );
  const [phoneInput, setPhoneInput] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [waContact, setWaContact] = useState(null);
  const [waBusy, setWaBusy] = useState(false);

  async function pullWaContact() {
    setWaBusy(true);
    try {
      const r = await api(`/api/inbox/conversations/${convId}/wa-contact`);
      setWaContact(r.info);
      mutate();
      toast.success('Info kontak WhatsApp di-pull');
    } catch (err) {
      toast.error(err.message);
    } finally { setWaBusy(false); }
  }

  async function savePhone() {
    setSavingPhone(true);
    try {
      const r = await api(`/api/inbox/conversations/${convId}/set-phone`, {
        method: 'POST',
        body: { phone: phoneInput },
      });
      if (r.linked) {
        toast.success(`Nomor disimpan & terhubung ke customer #${r.customer_id}`);
      } else if (r.real_phone) {
        toast.success('Nomor disimpan (tidak match customer manapun)');
      } else {
        toast.success('Nomor di-clear');
      }
      setPhoneInput('');
      mutate();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSavingPhone(false);
    }
  }

  if (isLoading) {
    return (
      <aside className="w-72 shrink-0 border-l border-slate-200 bg-slate-50 p-4">
        <div className="text-xs text-slate-400">Loading…</div>
      </aside>
    );
  }
  if (error) {
    return (
      <aside className="w-72 shrink-0 border-l border-slate-200 bg-slate-50 p-4">
        <div className="text-xs text-rose-600">{error.message || 'Gagal memuat'}</div>
      </aside>
    );
  }

  const p = data?.profile || {};
  const c = data?.conversation || {};

  return (
    <aside className="w-72 shrink-0 border-l border-slate-200 bg-slate-50 overflow-y-auto">
      <div className="p-4 space-y-4">
        <section>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Customer
          </div>
          <div className="bg-white rounded-md border border-slate-200 p-3 space-y-1">
            <div className="flex items-start gap-2">
              {waContact?.profile_picture_url && (
                <img
                  src={waContact.profile_picture_url} alt=""
                  className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 truncate">
                  {p.name || p.push_name || waContact?.name || <span className="text-slate-400">— belum terhubung</span>}
                </div>
                {waContact && (
                  <div className="text-[10px] text-slate-400 flex flex-wrap gap-1 mt-0.5">
                    {waContact.is_business && <span className="px-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">Business</span>}
                    {waContact.is_my_contact && <span className="px-1 rounded bg-sky-50 text-sky-700 border border-sky-200">Saved</span>}
                    {waContact.short_name && waContact.short_name !== waContact.name && (
                      <span title="WA short name">"{waContact.short_name}"</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            {/* Identifier rows — labeled untuk hindari kebingungan */}
            <dl className="text-xs space-y-0.5 mt-1">
              <div className="flex items-baseline gap-2">
                <dt className="text-[10px] text-slate-400 uppercase tracking-wider w-20 shrink-0">No. asli</dt>
                <dd className="text-slate-700 font-mono">
                  {p.real_phone
                    ? formatPhone(p.real_phone)
                    : (!p.is_lid ? formatPhone(p.phone) : <span className="text-slate-300">— belum di-set</span>)}
                </dd>
              </div>
              {p.is_lid && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-[10px] text-slate-400 uppercase tracking-wider w-20 shrink-0">JID (LID)</dt>
                  <dd className="text-slate-500 font-mono text-[10px] truncate" title={p.phone}>{p.phone}</dd>
                </div>
              )}
              {p.push_name && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-[10px] text-slate-400 uppercase tracking-wider w-20 shrink-0">Display WA</dt>
                  <dd className="text-slate-600 italic">"{p.push_name}"</dd>
                </div>
              )}
              {p.email && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-[10px] text-slate-400 uppercase tracking-wider w-20 shrink-0">Email</dt>
                  <dd className="text-slate-600 truncate" title={p.email}>{p.email}</dd>
                </div>
              )}
              {p.customer_id && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-[10px] text-slate-400 uppercase tracking-wider w-20 shrink-0">Customer</dt>
                  <dd className="text-slate-500 text-[10px]">#{p.customer_id}</dd>
                </div>
              )}
            </dl>
            {/* OSINT shortcuts (no auto-scrape, just open in new tab) */}
            <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-slate-100">
              <button
                onClick={pullWaContact}
                disabled={waBusy}
                className="text-[10px] px-2 py-0.5 rounded border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-50"
                title="Tarik nama + foto profil dari WhatsApp"
              >
                {waBusy ? '…' : '🟢 Pull WA'}
              </button>
              {(p.real_phone || (!p.is_lid && p.phone)) && (
                <a
                  href={`https://www.google.com/search?q=%22${encodeURIComponent('+' + (p.real_phone || p.phone).replace(/[^0-9]/g, ''))}%22`}
                  target="_blank" rel="noreferrer"
                  className="text-[10px] px-2 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-200"
                  title="Cari nomor di Google (manual)"
                >🔍 Google</a>
              )}
              {p.email && (
                <a
                  href={`https://www.google.com/search?q=%22${encodeURIComponent(p.email)}%22`}
                  target="_blank" rel="noreferrer"
                  className="text-[10px] px-2 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-200"
                  title="Cari email di Google"
                >🔍 Email</a>
              )}
              {(p.real_phone || (!p.is_lid && p.phone)) && (
                <a
                  href={`https://wa.me/${(p.real_phone || p.phone).replace(/[^0-9]/g, '')}`}
                  target="_blank" rel="noreferrer"
                  className="text-[10px] px-2 py-0.5 rounded border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-200"
                  title="Buka di WhatsApp"
                >💬 wa.me</a>
              )}
            </div>
          </div>
        </section>

        <NotesBlock convId={convId} toast={toast} />
        <TagsBlock convId={convId} toast={toast} />

        {/* Manual phone entry for LID-locked conversations */}
        {p.is_lid && (
          <section className="bg-amber-50 border border-amber-200 rounded-md p-3 space-y-2">
            <div className="text-[10px] font-semibold text-amber-800 uppercase tracking-wider">
              Set nomor asli
            </div>
            <div className="text-xs text-amber-900">
              {p.push_name && <div className="mb-1">WhatsApp name: <strong>{p.push_name}</strong></div>}
              Customer pakai privacy mode (LID). Tanya nomor mereka, masukkan di sini supaya bisa lookup ke profile customer.
            </div>
            <div className="flex gap-1.5">
              <input
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder={p.real_phone || '0812... atau 628...'}
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-amber-300 rounded font-mono"
              />
              <button
                onClick={savePhone}
                disabled={savingPhone}
                className="text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {savingPhone ? '…' : (p.real_phone ? 'Update' : 'Set')}
              </button>
            </div>
            {p.real_phone && (
              <button
                onClick={() => { setPhoneInput(''); savePhone(); }}
                className="text-[10px] text-amber-600 hover:text-amber-800 underline"
              >
                Clear nomor manual
              </button>
            )}
          </section>
        )}

        {p.customer_id ? (
          <>
            {p.health && (
              <section>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Customer health</div>
                <div className={`flex items-center justify-between rounded-md border p-3 ${
                  p.health.band === 'vip' ? 'bg-emerald-50 border-emerald-200' :
                  p.health.band === 'warm' ? 'bg-blue-50 border-blue-200' :
                  p.health.band === 'cold' ? 'bg-amber-50 border-amber-200' :
                  p.health.band === 'at_risk' ? 'bg-rose-50 border-rose-200' :
                  'bg-slate-50 border-slate-200'
                }`}>
                  <div>
                    <div className="text-2xl font-semibold text-slate-800">{p.health.score}</div>
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">{p.health.band}</div>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    diupdate {new Date(p.health.computed_at).toLocaleDateString('id-ID')}
                  </div>
                </div>
              </section>
            )}
            <PipelineBlock conv={p} onMutate={() => mutate()} toast={toast} />
            {Array.isArray(p.facts) && p.facts.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">Fakta dari chat</div>
                <ul className="text-xs space-y-1">
                  {p.facts.map((f) => (
                    <li key={f.fact_key} className="flex gap-2">
                      <span className="text-slate-500 capitalize w-32 shrink-0">{f.fact_key.replace(/_/g, ' ')}</span>
                      <span className="text-slate-800 break-words">{f.fact_value}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Lifetime</span>
                {p.recency_bucket && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] normal-case font-normal border ${
                    p.recency_bucket === 'active'   ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                    p.recency_bucket === 'dormant'  ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                                      'bg-slate-50 text-slate-500 border-slate-200'
                  }`} title={`Order terakhir ${p.days_since_last_order ?? '?'} hari lalu`}>
                    {p.recency_bucket} · {p.days_since_last_order}d
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white rounded-md border border-slate-200 p-3">
                  <div className="text-[10px] text-slate-500 uppercase">Orders</div>
                  <div className="text-lg font-semibold text-slate-800 mt-0.5">{p.total_orders}</div>
                </div>
                <div className="bg-white rounded-md border border-slate-200 p-3">
                  <div className="text-[10px] text-slate-500 uppercase">Total spent</div>
                  <div className="text-base font-semibold text-slate-800 mt-0.5">{formatRupiah(p.total_spent)}</div>
                </div>
                {p.aov > 0 && (
                  <div className="bg-white rounded-md border border-slate-200 p-3 col-span-2">
                    <div className="text-[10px] text-slate-500 uppercase">Avg order value</div>
                    <div className="text-sm font-semibold text-slate-800 mt-0.5">{formatRupiah(p.aov)}</div>
                  </div>
                )}
              </div>
            </section>

            {Array.isArray(p.top_categories) && p.top_categories.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  Kategori favorit
                </div>
                <ul className="bg-white rounded-md border border-slate-200 divide-y divide-slate-100">
                  {p.top_categories.map((c, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-2 text-xs">
                      <span className="text-slate-700 truncate" title={c.category}>{c.category}</span>
                      <span className="text-slate-500 tabular-nums">{c.times}× · {formatRupiah(Number(c.total))}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {Array.isArray(p.recipients) && p.recipients.length > 0 && (
              <section>
                <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  Sering kirim ke
                </div>
                <ul className="bg-white rounded-md border border-slate-200 divide-y divide-slate-100">
                  {p.recipients.map((r, i) => (
                    <li key={i} className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-800 font-medium truncate" title={r.name}>{r.name}</span>
                        <span className="text-slate-400 tabular-nums shrink-0 ml-2">{r.times}×</span>
                      </div>
                      <div className="text-slate-500 mt-0.5 flex items-center justify-between">
                        <span className="truncate">{r.city || <span className="text-slate-300">—</span>}</span>
                        {r.last_at && <span className="text-slate-400 text-[10px]">{formatRelative(r.last_at)}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : !p.is_lid && (
          <section className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800">
            Phone tidak match dengan customer manapun di Prestisa DB.
          </section>
        )}

        <section>
          <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Conversation
          </div>
          <div className="bg-white rounded-md border border-slate-200 p-3 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500">Status</span>
              <span className="text-slate-700 font-medium">{c.status}</span>
            </div>
            {c.last_intent && (
              <div className="flex justify-between">
                <span className="text-slate-500">Last intent</span>
                <span className="text-slate-700">{c.last_intent}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">Handover count</span>
              <span className="text-slate-700">{c.handover_count}</span>
            </div>
            {c.shadow_mode && (
              <div className="flex justify-between">
                <span className="text-slate-500">Shadow mode</span>
                <span className="text-amber-700 font-medium">ON</span>
              </div>
            )}
            {c.wa_session && (
              <div className="flex justify-between">
                <span className="text-slate-500">WA session</span>
                <span className="text-slate-700 font-mono">{c.wa_session}</span>
              </div>
            )}
          </div>
        </section>

        <CsatButton convId={convId} toast={toast} />

        {Array.isArray(p.recent_orders) && p.recent_orders.length > 0 && (
          <section>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Recent orders
            </div>
            <ul className="space-y-2">
              {p.recent_orders.map((o) => (
                <li key={o.id} className="bg-white rounded-md border border-slate-200 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono text-slate-700 truncate" title={o.order_number}>
                      {o.order_number || `#${o.id}`}
                    </span>
                    <StatusPill s={o.payment_status || 'unknown'} />
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-xs text-slate-500">
                    <span>{formatRupiah(o.total)}</span>
                    <span>{formatRelative(o.created_at)}</span>
                  </div>
                  {o.status && <div className="text-[10px] text-slate-400 mt-1">{o.status}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
