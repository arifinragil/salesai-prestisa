import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative } from '@/lib/format';

const EMPTY_DRAFT = {
  id: null,
  name: '',
  description: '',
  params: [],
  sql_text: '',
  enabled: true,
  row_limit: 20,
};

export default function SqlQueriesPage() {
  const toast = useToast();
  const list = useSWR('/api/admin/sql-queries', fetcher);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testParams, setTestParams] = useState({});
  const [testResult, setTestResult] = useState(null);

  function pick(item) {
    setDraft({
      id: item.id,
      name: item.name,
      description: item.description,
      params: item.params || [],
      sql_text: item.sql_text,
      enabled: item.enabled,
      row_limit: item.row_limit,
    });
    const init = {};
    (item.params || []).forEach((p) => { init[p.name] = ''; });
    setTestParams(init);
    setTestResult(null);
  }

  function newDraft() {
    setDraft({ ...EMPTY_DRAFT, params: [] });
    setTestParams({});
    setTestResult(null);
  }

  async function save() {
    setBusy(true);
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        params: draft.params,
        sql_text: draft.sql_text,
        row_limit: draft.row_limit,
      };
      let saved;
      if (draft.id) {
        await api(`/api/admin/sql-queries/${draft.id}`, {
          method: 'PUT',
          body: { ...body, enabled: draft.enabled },
        });
        toast.success('Saved');
        saved = draft.id;
      } else {
        const r = await api('/api/admin/sql-queries', { method: 'POST', body });
        toast.success(`Created #${r.id}`);
        saved = r.id;
      }
      list.mutate();
      // Re-pick to show fresh state
      const items = (await api('/api/admin/sql-queries')).items || [];
      const item = items.find((i) => i.id === saved);
      if (item) pick(item);
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!draft.id) return;
    if (!confirm(`Hapus query "${draft.name}"?`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/sql-queries/${draft.id}`, { method: 'DELETE' });
      toast.success('Deleted');
      list.mutate();
      newDraft();
    } catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api('/api/admin/sql-queries/test', {
        method: 'POST',
        body: { name: draft.name, params: testParams },
      });
      setTestResult(r);
    } catch (err) {
      setTestResult({ error: err.message });
    } finally { setTesting(false); }
  }

  function updateParam(idx, field, val) {
    const next = [...draft.params];
    next[idx] = { ...next[idx], [field]: val };
    setDraft({ ...draft, params: next });
  }
  function addParam() {
    setDraft({ ...draft, params: [...draft.params, { name: '', type: 'string', required: false, description: '' }] });
  }
  function removeParam(idx) {
    setDraft({ ...draft, params: draft.params.filter((_, i) => i !== idx) });
  }

  return (
    <Layout title="SQL Queries — Tiara">
      <div className="max-w-7xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Named SQL Queries</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              SQL templates yang AI bisa panggil via tool <code className="font-mono">run_named_query</code>.
              Hanya <span className="font-medium">SELECT</span>, parameter via <code>:nama</code> placeholder.
            </p>
          </div>
          <button
            onClick={newDraft}
            className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600"
          >
            + New
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* List */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
              {(list.data?.items || []).length} queries
            </div>
            <ul className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
              {(list.data?.items || []).map((q) => (
                <li key={q.id}>
                  <button
                    onClick={() => pick(q)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${
                      draft.id === q.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-slate-800 truncate">{q.name}</span>
                      {!q.enabled && (
                        <span className="text-[10px] text-slate-400 border border-slate-200 px-1.5 rounded">
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">{q.description}</div>
                    <div className="text-[10px] text-slate-400 mt-1">
                      {(q.params || []).length} params · limit {q.row_limit} · {formatRelative(q.updated_at)}
                    </div>
                  </button>
                </li>
              ))}
              {list.data?.items?.length === 0 && (
                <li className="px-4 py-6 text-sm text-slate-400 text-center">
                  Belum ada query. Klik “+ New” untuk bikin.
                </li>
              )}
            </ul>
          </div>

          {/* Editor + tester */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700">
                  {draft.id ? `Edit #${draft.id}` : 'New query'}
                </h2>
                {draft.id && (
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    />
                    enabled
                  </label>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="text-xs text-slate-600">
                  <div className="mb-1">Name (snake_case)</div>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                    placeholder="top_seller_per_kota"
                    className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded font-mono"
                  />
                </label>
                <label className="text-xs text-slate-600 md:col-span-2">
                  <div className="mb-1">Description (AI baca ini untuk decide kapan pakai)</div>
                  <input
                    type="text"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    placeholder="Top 10 produk terlaris di kota X..."
                    className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded"
                  />
                </label>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs text-slate-600 font-medium">Parameters</div>
                  <button onClick={addParam} className="text-xs text-brand-700 hover:underline">+ add</button>
                </div>
                {draft.params.length === 0 && (
                  <div className="text-xs text-slate-400 italic mb-2">Tidak ada parameter (query tanpa input).</div>
                )}
                {draft.params.map((p, idx) => (
                  <div key={idx} className="flex gap-2 mb-1.5">
                    <input
                      type="text" placeholder="name"
                      value={p.name}
                      onChange={(e) => updateParam(idx, 'name', e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      className="flex-1 px-2 py-1 text-xs border border-slate-200 rounded font-mono"
                    />
                    <select
                      value={p.type || 'string'}
                      onChange={(e) => updateParam(idx, 'type', e.target.value)}
                      className="px-2 py-1 text-xs border border-slate-200 rounded bg-white"
                    >
                      <option value="string">string</option>
                      <option value="integer">integer</option>
                      <option value="number">number</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-600 px-1">
                      <input
                        type="checkbox" checked={!!p.required}
                        onChange={(e) => updateParam(idx, 'required', e.target.checked)}
                      />
                      req
                    </label>
                    <input
                      type="text" placeholder="description (optional)"
                      value={p.description || ''}
                      onChange={(e) => updateParam(idx, 'description', e.target.value)}
                      className="flex-[2] px-2 py-1 text-xs border border-slate-200 rounded"
                    />
                    <button
                      onClick={() => removeParam(idx)}
                      className="text-xs text-rose-600 px-1.5 hover:bg-rose-50 rounded"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <label className="text-xs text-slate-600 block">
                <div className="mb-1 flex items-center justify-between">
                  <span>SQL (gunakan <code>:param</code> placeholder)</span>
                  <span className="text-[10px] text-slate-400">SELECT-only · max row_limit:</span>
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={draft.sql_text}
                    onChange={(e) => setDraft({ ...draft, sql_text: e.target.value })}
                    placeholder="SELECT id, name FROM products WHERE name LIKE :q LIMIT 10"
                    rows={10}
                    spellCheck={false}
                    className="flex-1 font-mono text-xs px-2 py-1.5 border border-slate-200 rounded resize-y"
                  />
                  <input
                    type="number" min="1" max="100"
                    value={draft.row_limit}
                    onChange={(e) => setDraft({ ...draft, row_limit: parseInt(e.target.value) || 20 })}
                    className="w-16 px-2 py-1.5 text-xs border border-slate-200 rounded text-center self-start"
                  />
                </div>
              </label>

              <div className="flex justify-end gap-2 pt-1">
                {draft.id && (
                  <button onClick={remove} disabled={busy} className="text-xs px-3 py-1.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                    Delete
                  </button>
                )}
                <button
                  onClick={save}
                  disabled={busy || !draft.name || !draft.description || !draft.sql_text}
                  className="text-sm px-3 py-1.5 rounded bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40"
                >
                  {busy ? '…' : (draft.id ? 'Save changes' : 'Create')}
                </button>
              </div>
            </div>

            {/* Tester */}
            {draft.name && (
              <div className="bg-white border border-slate-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Test runner</h3>
                <div className="space-y-2">
                  {draft.params.length === 0 && (
                    <div className="text-xs text-slate-400 italic">Tidak ada param — langsung Run.</div>
                  )}
                  {draft.params.map((p) => (
                    <label key={p.name || Math.random()} className="block text-xs text-slate-600">
                      <div className="mb-0.5 font-mono">
                        :{p.name} {p.required && <span className="text-rose-500">*</span>}
                        {p.description && <span className="text-slate-400 font-normal ml-1">— {p.description}</span>}
                      </div>
                      <input
                        type={p.type === 'integer' || p.type === 'number' ? 'number' : 'text'}
                        value={testParams[p.name] || ''}
                        onChange={(e) => setTestParams({ ...testParams, [p.name]: e.target.value })}
                        className="w-full px-2 py-1 text-sm border border-slate-200 rounded"
                      />
                    </label>
                  ))}
                  <button
                    onClick={runTest}
                    disabled={testing || !draft.id}
                    className="text-sm px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40"
                  >
                    {testing ? 'Running…' : 'Run test'}
                  </button>
                  {!draft.id && (
                    <div className="text-[11px] text-slate-400">Save dulu sebelum bisa test.</div>
                  )}
                </div>

                {testResult && (
                  <div className="mt-3">
                    {testResult.error ? (
                      <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded p-2">
                        {testResult.error}
                      </div>
                    ) : (
                      <div>
                        <div className="text-xs text-slate-500 mb-2">
                          {testResult.row_count} rows {testResult.truncated ? `(truncated at ${draft.row_limit})` : ''}
                        </div>
                        <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded p-2 overflow-x-auto max-h-64">
{JSON.stringify(testResult.rows, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
