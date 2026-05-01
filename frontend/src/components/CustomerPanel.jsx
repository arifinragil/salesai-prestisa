import useSWR from 'swr';
import { fetcher } from '@/lib/api';
import { formatRupiah, formatRelative, formatPhone } from '@/lib/format';

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
  const { data, error, isLoading } = useSWR(
    convId ? `/api/inbox/conversations/${convId}/customer` : null,
    fetcher,
    { refreshInterval: 60_000 }
  );

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
            <div className="text-sm font-medium text-slate-800">
              {p.name || <span className="text-slate-400">— belum terhubung</span>}
            </div>
            <div className="text-xs text-slate-500 font-mono">{formatPhone(p.phone)}</div>
            {p.email && <div className="text-xs text-slate-500 truncate" title={p.email}>{p.email}</div>}
            {p.customer_id && (
              <div className="text-[10px] text-slate-400 mt-1">customer_id #{p.customer_id}</div>
            )}
          </div>
        </section>

        {p.customer_id ? (
          <section>
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Lifetime
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
            </div>
          </section>
        ) : (
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
