import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import { useUser } from '@/lib/useUser';

// ─── helpers ─────────────────────────────────────────────────────────────────
const fmtNum = (n) => new Intl.NumberFormat('id-ID').format(n ?? 0);
const fmtPct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '0%');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const ISSUE_COLOR = {
  Produk: '#0d9488',
  'Harga, Promo & Payment': '#dc2626',
  Customer: '#9333ea',
  'Sales Handling & Follow Up': '#f97316',
  'Kualitas Lead': '#0284c7',
  Mitra: '#d97706',
};
const DEFAULT_COLOR = '#64748b';

// ─── small reusable components ────────────────────────────────────────────────

function Kpi({ label, value, hint, accentClass }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accentClass ?? 'text-gray-900'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

function ProportionalBar({ value, max, color, height = 'h-2.5' }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className={`${height} flex-1 overflow-hidden rounded-full bg-gray-100`}>
      <div className={`h-full rounded-full`} style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

function ThemeList({ data, tone }) {
  if (!data || data.length === 0) {
    return <p className="py-4 text-center text-xs text-gray-400">Belum ada data.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  const barColor = tone === 'good' ? '#10b981' : '#f43f5e';
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.theme}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-800">{d.theme}</span>
            <span className="font-semibold text-gray-500">{d.count}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${(d.count / max) * 100}%`, backgroundColor: barColor }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function ActionThemeBars({ data }) {
  if (!data || data.length === 0) {
    return <p className="py-4 text-center text-xs text-gray-400">Belum ada data.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.theme}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-800">{d.theme}</span>
            <span className="font-semibold text-gray-500">{d.count}</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${(d.count / max) * 100}%`, backgroundColor: '#0d9488' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── issue tree ───────────────────────────────────────────────────────────────

function IssueTree({ data }) {
  const [openIssue, setOpenIssue] = useState({});
  const [openSub, setOpenSub] = useState({});
  const [openRinci, setOpenRinci] = useState({});

  if (!data || data.length === 0) {
    return (
      <p className="py-8 text-center text-xs text-gray-400">
        Belum ada lead yang ditandai issue tree.
      </p>
    );
  }

  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <ul className="space-y-1.5">
      {data.map((node) => {
        const color = ISSUE_COLOR[node.issue] ?? DEFAULT_COLOR;
        const isOpen = openIssue[node.issue] ?? false;
        const subMax = node.subs && node.subs.length > 0
          ? Math.max(...node.subs.map((s) => s.count), 1)
          : 1;

        return (
          <li key={node.issue} className="rounded-md border border-gray-200">
            {/* Level 1 */}
            <button
              type="button"
              onClick={() => setOpenIssue((o) => ({ ...o, [node.issue]: !isOpen }))}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-gray-50"
            >
              <span
                className="text-xs text-gray-400 transition-transform"
                style={{ display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
              <span className="w-44 shrink-0 text-xs font-semibold text-gray-800">{node.issue}</span>
              <ProportionalBar value={node.count} max={max} color={color} height="h-2.5" />
              <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-gray-800">
                {node.count}
              </span>
            </button>

            {/* Level 2 */}
            {isOpen && (
              <ul className="space-y-0.5 border-t border-gray-100 bg-gray-50/60 px-2 py-1.5">
                {(node.subs || []).map((s) => {
                  const subKey = `${node.issue}|${s.subIssue}`;
                  const subOpen = openSub[subKey] ?? false;
                  const rinciMax = s.rinci && s.rinci.length > 0
                    ? Math.max(...s.rinci.map((r) => r.count), 1)
                    : 1;

                  return (
                    <li key={s.subIssue} className="rounded">
                      <button
                        type="button"
                        onClick={() => setOpenSub((o) => ({ ...o, [subKey]: !subOpen }))}
                        className="flex w-full items-center gap-2 px-1 py-1 text-left transition-colors hover:bg-gray-100"
                      >
                        <span
                          className="text-xs text-gray-300 transition-transform"
                          style={{ display: 'inline-block', transform: subOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                        >
                          ▶
                        </span>
                        <span className="w-48 shrink-0 text-xs font-medium text-gray-700">{s.subIssue}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                          <div
                            className="h-full rounded-full opacity-70"
                            style={{ width: `${(s.count / subMax) * 100}%`, backgroundColor: color }}
                          />
                        </div>
                        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-gray-500">
                          {s.count}
                        </span>
                      </button>

                      {/* Level 3 */}
                      {subOpen && (
                        <ul className="space-y-0.5 py-0.5 pl-7 pr-1">
                          {(s.rinci || []).map((r) => {
                            const rinciKey = `${subKey}|${r.rinci}`;
                            const rinciOpen = openRinci[rinciKey] ?? false;

                            return (
                              <li key={r.rinci}>
                                <button
                                  type="button"
                                  onClick={() => setOpenRinci((o) => ({ ...o, [rinciKey]: !rinciOpen }))}
                                  className="flex w-full items-center gap-2 px-1 py-1 text-left transition-colors hover:bg-gray-100"
                                >
                                  <span
                                    className="text-xs text-gray-300 transition-transform"
                                    style={{
                                      display: 'inline-block',
                                      transform: rinciOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                                    }}
                                  >
                                    ▶
                                  </span>
                                  <span className="flex-1 text-xs text-gray-500">{r.rinci}</span>
                                  <div className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-gray-200">
                                    <div
                                      className="h-full rounded-full opacity-60"
                                      style={{
                                        width: `${(r.count / rinciMax) * 100}%`,
                                        backgroundColor: color,
                                      }}
                                    />
                                  </div>
                                  <span className="w-7 shrink-0 text-right text-xs tabular-nums text-gray-400">
                                    {r.count}
                                  </span>
                                </button>

                                {/* Level 4 — leads */}
                                {rinciOpen && (
                                  <ul className="space-y-1 py-1 pl-7 pr-1">
                                    {(r.leads || []).map((lead, i) => (
                                      <li
                                        key={`${lead.phone}-${i}`}
                                        className="flex items-start gap-2 rounded bg-white px-2 py-1.5 shadow-sm"
                                      >
                                        <div className="min-w-0 flex-1">
                                          <span className="font-mono text-xs text-gray-800">{lead.phone}</span>
                                          {lead.detail && (
                                            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-gray-400">
                                              {lead.detail}
                                            </p>
                                          )}
                                        </div>
                                        <a
                                          href={`/lotus-inbox/${encodeURIComponent(lead.phone)}`}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
                                        >
                                          Buka chat
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function AnalisaTidakClosingPage() {
  const { user, isLoading: userLoading } = useUser({ redirectTo: '/login' });

  const [from, setFrom] = useState(daysAgoStr(29));
  const [to, setTo] = useState(todayStr);

  const url = `/api/penyebab/analysis?from=${from}&to=${to}`;
  const { data, error, isLoading } = useSWR(url, fetcher);

  if (userLoading) {
    return (
      <Layout title="Analisa Tidak Closing">
        <div className="p-10 text-center text-gray-400">Memuat…</div>
      </Layout>
    );
  }

  if (user?.role !== 'admin') {
    return (
      <Layout title="Analisa Tidak Closing">
        <div className="p-10 text-center text-rose-600 font-semibold">
          Halaman ini khusus admin.
        </div>
      </Layout>
    );
  }

  const totals = data?.totals ?? { nonClosing: 0, churn: 0, structuredCount: 0, taggedCount: 0 };
  const issueTree = data?.issueTree ?? [];
  const penyebabDist = data?.penyebabDist ?? [];
  const salesStrengths = data?.salesStrengths ?? [];
  const salesProblems = data?.salesProblems ?? [];
  const actionThemes = data?.actionThemes ?? [];
  const priorityCounts = data?.priorityCounts ?? { p1: 0, p2: 0, p3: 0 };

  const isEmpty = !isLoading && !error && data && totals.nonClosing === 0;

  return (
    <Layout title="Analisa Tidak Closing">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {/* Header + date range */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Analisa Penyebab Tidak Closing</h1>
            <p className="text-xs text-gray-500">
              Agregasi mendalam dari analisa AI 5-Why / POV Sales / Action untuk lead yang tidak closing.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 text-xs text-gray-600">
              <label className="font-medium">Dari</label>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-400"
              />
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-600">
              <label className="font-medium">s/d</label>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-400"
              />
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
            ⚠ {error.message ?? String(error)}
          </div>
        )}

        {/* Loading skeleton */}
        {isLoading && !data && (
          <div className="h-64 w-full animate-pulse rounded-xl bg-gray-100" />
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="rounded-md border border-gray-200 bg-white p-10 text-center text-sm text-gray-400">
            Belum ada data analisa untuk rentang ini.
          </div>
        )}

        {/* Main content */}
        {data && totals.nonClosing > 0 && (
          <>
            {/* a. KPI strip */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Kpi
                label="Lead tidak closing"
                value={fmtNum(totals.nonClosing)}
                hint="lead teranalisa di periode"
              />
              <Kpi
                label="Risiko churn"
                value={fmtPct(totals.churn, totals.structuredCount)}
                hint={`${fmtNum(totals.churn)} dari ${fmtNum(totals.structuredCount)} analisa mendalam`}
                accentClass="text-rose-600"
              />
              <Kpi
                label="Ter-tag"
                value={fmtNum(totals.taggedCount)}
                hint={`dari ${fmtNum(totals.structuredCount)} analisa mendalam`}
              />
            </div>

            {/* Low-sample warning */}
            {totals.taggedCount > 0 && totals.taggedCount < 20 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <span className="mt-0.5 shrink-0">⚠</span>
                <span>
                  Baru {totals.taggedCount} lead yang ditandai issue tree pada filter ini — angka di bawah masih
                  indikatif. Perlebar periode untuk basis lebih besar.
                </span>
              </div>
            )}

            {/* b. Issue Tree */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">Issue Tree (klasifikasi resmi)</h2>
                <p className="text-xs text-gray-400">
                  Penyebab utama menurut taksonomi resmi, ditandai AI dari {fmtNum(totals.taggedCount)} lead.
                  Klik issue → sub-issue untuk lihat hingga Keterangan Rinci.
                </p>
              </div>
              <div className="p-4">
                <IssueTree data={issueTree} />
              </div>
            </div>

            {/* c. Sales POV — side by side */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-gray-200 bg-white">
                <div className="border-b border-gray-100 px-4 py-3">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <span className="text-emerald-600">👍</span> Kekuatan Sales
                  </h2>
                  <p className="text-xs text-gray-400">Hal yang sudah baik menurut analisa.</p>
                </div>
                <div className="p-4">
                  <ThemeList data={salesStrengths} tone="good" />
                </div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-white">
                <div className="border-b border-gray-100 px-4 py-3">
                  <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                    <span className="text-rose-600">👎</span> Masalah Sales
                  </h2>
                  <p className="text-xs text-gray-400">Pola kelemahan yang teridentifikasi.</p>
                </div>
                <div className="p-4">
                  <ThemeList data={salesProblems} tone="bad" />
                </div>
              </div>
            </div>

            {/* d. Rekomendasi Tindakan */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                      <span className="text-teal-600">✅</span> Rekomendasi Tindakan
                    </h2>
                    <p className="text-xs text-gray-400">Tema action items tersering dari analisa.</p>
                  </div>
                  <div className="flex gap-1.5 text-xs">
                    <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">
                      P1 {priorityCounts.p1}
                    </span>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
                      P2 {priorityCounts.p2}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
                      P3 {priorityCounts.p3}
                    </span>
                  </div>
                </div>
              </div>
              <div className="p-4">
                <ActionThemeBars data={actionThemes} />
              </div>
            </div>

            {/* e. Sebaran Penyebab table */}
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-900">Sebaran Penyebab</h2>
                <p className="text-xs text-gray-400">
                  {fmtNum(totals.nonClosing)} lead tidak closing, dikelompokkan per kategori Issue Tree.
                  {totals.nonClosing - totals.taggedCount > 0 && (
                    <> Sisa <strong>{fmtNum(totals.nonClosing - totals.taggedCount)}</strong> belum di-tag AI.</>
                  )}
                </p>
              </div>
              <div className="p-4">
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2">Kategori</th>
                        <th className="px-3 py-2 text-right">Jumlah</th>
                        <th className="px-3 py-2 text-right">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {penyebabDist.map((row) => (
                        <tr key={row.category} className="border-t border-gray-100">
                          <td className="px-3 py-2 text-gray-800">{row.category}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                            {fmtNum(row.count)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                            {fmtPct(row.count, totals.nonClosing)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
