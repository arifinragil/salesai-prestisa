import { useRouter } from 'next/router';
import Link from 'next/link';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative, formatPhone } from '@/lib/format';

const PROSPECT_BADGE = {
  pending:     'bg-slate-100 text-slate-600 border-slate-200',
  in_progress: 'bg-amber-100 text-amber-700 border-amber-200',
  replied:     'bg-emerald-100 text-emerald-700 border-emerald-200',
  opted_out:   'bg-rose-100 text-rose-700 border-rose-200',
  completed:   'bg-sky-100 text-sky-700 border-sky-200',
  failed:      'bg-rose-100 text-rose-700 border-rose-200',
};

export default function B2BCampaignDetail() {
  const router = useRouter();
  const toast = useToast();
  const id = router.query.id;
  const me = useSWR('/api/auth/me', fetcher);
  const data = useSWR(id ? `/api/b2b/campaigns/${id}` : null, fetcher, { refreshInterval: 15_000 });

  const isAdmin = me.data?.user?.role === 'admin';
  if (me.data && !isAdmin) {
    return <Layout title="Campaign"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  const c = data.data?.campaign;
  const prospects = data.data?.prospects || [];

  async function action(name) {
    try {
      await api(`/api/b2b/campaigns/${id}/${name}`, { method: 'POST' });
      toast.success(name);
      data.mutate();
    } catch (e) { toast.error(e.message); }
  }

  if (!c) return <Layout title="Campaign"><div className="p-12 text-center text-slate-400">Loading…</div></Layout>;

  const counts = {
    pending: prospects.filter((p) => p.status === 'pending').length,
    in_progress: prospects.filter((p) => p.status === 'in_progress').length,
    replied: prospects.filter((p) => p.status === 'replied').length,
    opted_out: prospects.filter((p) => p.status === 'opted_out').length,
    completed: prospects.filter((p) => p.status === 'completed').length,
  };

  return (
    <Layout title={`${c.name} — B2B`}>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <Link href="/b2b-outreach" className="text-sm text-slate-500 hover:underline">← All campaigns</Link>

        <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">{c.name}</h1>
            <div className="text-xs text-slate-500 mt-1">
              status: <b>{c.status}</b> · created {formatRelative(c.created_at)}
              {c.launched_at && <> · launched {formatRelative(c.launched_at)}</>}
            </div>
          </div>
          <div className="flex gap-2">
            {c.status === 'draft' && (
              <button onClick={() => action('launch')}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600">
                🚀 Launch
              </button>
            )}
            {c.status === 'active' && (
              <button onClick={() => action('pause')}
                className="text-sm px-3 py-1.5 rounded bg-amber-500 text-white hover:bg-amber-600">
                ⏸ Pause
              </button>
            )}
            {c.status === 'paused' && (
              <button onClick={() => action('resume')}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600">
                ▶ Resume
              </button>
            )}
            {c.status !== 'cancelled' && c.status !== 'completed' && (
              <button onClick={() => { if (confirm('Cancel campaign? Tidak bisa di-resume.')) action('cancel'); }}
                className="text-sm px-3 py-1.5 rounded border border-rose-200 text-rose-700 hover:bg-rose-50">
                ✕ Cancel
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {Object.entries(counts).map(([k, n]) => (
            <div key={k} className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="text-xs text-slate-500 capitalize">{k.replace('_', ' ')}</div>
              <div className="text-xl font-semibold text-slate-800">{n}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Sequence ({c.sequence?.length || 0} steps)</h2>
          {(c.sequence || []).map((s, i) => (
            <div key={i} className="text-xs border border-slate-100 rounded p-2 mb-1">
              <div className="font-medium text-slate-700 mb-1">Step {i+1} · delay {s.delay_days}d</div>
              <div className="whitespace-pre-wrap text-slate-600">{s.body_template}</div>
            </div>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Prospects ({prospects.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[600px]">
              <thead className="text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-1">Name</th>
                  <th className="text-left py-1">Phone</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-right py-1">Step</th>
                  <th className="text-left py-1">Next</th>
                  <th className="text-left py-1">Last sent</th>
                  <th className="text-left py-1">Reply</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {prospects.map((p) => (
                  <tr key={p.id}>
                    <td className="py-1">
                      {p.conversation_id
                        ? <Link href={`/inbox/${p.conversation_id}`} className="text-brand-700 hover:underline">{p.customer_name}</Link>
                        : p.customer_name}
                    </td>
                    <td className="py-1 font-mono">{formatPhone(p.phone)}</td>
                    <td className="py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded border ${PROSPECT_BADGE[p.status]}`}>{p.status}</span></td>
                    <td className="py-1 text-right">{p.current_step}/{c.sequence?.length || 0}</td>
                    <td className="py-1 text-slate-500">{p.next_step_at ? formatRelative(p.next_step_at) : '—'}</td>
                    <td className="py-1 text-slate-500">{p.last_step_at ? formatRelative(p.last_step_at) : '—'}</td>
                    <td className="py-1 text-emerald-600">{p.reply_at ? formatRelative(p.reply_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
