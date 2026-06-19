import { useEffect, useMemo, useState } from 'react';
import Layout from '@/components/Layout';
import { api } from '@/lib/api';

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_META = {
  requested:  { label: 'Diminta',   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  processing: { label: 'Diproses',  cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  done:       { label: 'Selesai',   cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejected:   { label: 'Ditolak',   cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

function StatusPill({ status }) {
  const m = STATUS_META[status] || { label: status, cls: 'bg-slate-100 text-slate-600 border-slate-200' };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${m.cls}`}>{m.label}</span>;
}

const FILTERS = [
  { key: 'requested', label: 'Diminta' },
  { key: 'processing', label: 'Diproses' },
  { key: 'done', label: 'Selesai' },
  { key: '', label: 'Semua' },
];

export default function TaxRequestsPage() {
  const [statusFilter, setStatusFilter] = useState('requested');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set('status', statusFilter);
      qs.set('limit', '300');
      const data = await api(`/api/tax-requests?${qs.toString()}`);
      setRows(data?.requests || []);
      setSummary(data?.summary || {});
    } catch (e) {
      setError(e.message || 'Gagal memuat daftar.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function setStatus(id, status) {
    setBusyId(id);
    try {
      await api(`/api/tax-requests/${id}`, { method: 'PATCH', body: { status } });
      await refresh();
    } catch (e) {
      setError(e.message || 'Gagal memperbarui.');
    } finally {
      setBusyId(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      [r.order_number, r.customer_name, r.customer_email].some(v => (v || '').toLowerCase().includes(q))
    );
  }, [rows, search]);

  return (
    <Layout>
      <div className="p-4 sm:p-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-slate-800">🧾 Permintaan Faktur Pajak</h1>
            <p className="text-sm text-slate-500">Permintaan faktur pajak dari portal pelanggan.</p>
          </div>
          <div className="text-xs text-slate-500 flex gap-2">
            <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-1 text-amber-700">Diminta: {summary.requested || 0}</span>
            <span className="rounded-full bg-blue-50 border border-blue-200 px-2 py-1 text-blue-700">Diproses: {summary.processing || 0}</span>
            <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-1 text-emerald-700">Selesai: {summary.done || 0}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                statusFilter === f.key ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {f.label}
            </button>
          ))}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Cari order / nama / email…"
            className="ml-auto h-9 w-64 max-w-full rounded-lg border border-slate-200 px-3 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
          />
        </div>

        {error && <p className="mb-3 text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg">{error}</p>}

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left font-semibold px-4 py-2.5">Nomor Order</th>
                <th className="text-left font-semibold px-4 py-2.5">Pelanggan</th>
                <th className="text-left font-semibold px-4 py-2.5">Data NPWP</th>
                <th className="text-left font-semibold px-4 py-2.5">Diminta</th>
                <th className="text-left font-semibold px-4 py-2.5">Status</th>
                <th className="text-left font-semibold px-4 py-2.5">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Memuat…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Tidak ada permintaan.</td></tr>
              ) : filtered.map(r => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{r.order_number}</td>
                  <td className="px-4 py-2.5">
                    <div className="text-slate-800">{r.customer_name || '-'}</div>
                    <div className="text-xs text-slate-400">{r.customer_email || ''}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <div className="text-slate-800">{r.npwp_name || '-'}</div>
                    <div className="font-mono text-slate-500">{r.npwp_number || '-'}</div>
                    {r.nitku && <div className="font-mono text-[11px] text-slate-400">NITKU: {r.nitku}</div>}
                    {r.npwp_address && <div className="text-[11px] text-slate-400 max-w-[220px] truncate" title={r.npwp_address}>{r.npwp_address}</div>}
                    {r.npwp_file && <a href={r.npwp_file} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">📎 Lihat file NPWP</a>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                  <td className="px-4 py-2.5"><StatusPill status={r.status} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {r.status !== 'processing' && r.status !== 'done' && (
                        <button disabled={busyId === r.id} onClick={() => setStatus(r.id, 'processing')}
                          className="px-2 py-1 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 text-xs disabled:opacity-50">Proses</button>
                      )}
                      {r.status !== 'done' && (
                        <button disabled={busyId === r.id} onClick={() => setStatus(r.id, 'done')}
                          className="px-2 py-1 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 text-xs disabled:opacity-50">Selesai</button>
                      )}
                      {r.status !== 'rejected' && (
                        <button disabled={busyId === r.id} onClick={() => setStatus(r.id, 'rejected')}
                          className="px-2 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs disabled:opacity-50">Tolak</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
