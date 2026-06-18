import { useState, useEffect } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { useUser } from '@/lib/useUser';
import { api, fetcher } from '@/lib/api';
import { navItems, CONFIGURABLE_ROLES } from '@/lib/menuCatalog';

const ROLE_LABEL = {
  operator: 'Operator (CS)',
  viewer: 'Viewer',
  acquisition: 'Acquisition',
  retention: 'Retention',
  staff: 'Staff (legacy)',
};
const labelFor = (role) => ROLE_LABEL[role] || (role.charAt(0).toUpperCase() + role.slice(1));

// Where the role comes from in Authentik (shown under the column label).
function hintFor(meta) {
  if (!meta) return '';
  if (meta.groups && meta.groups.length) return `Authentik: ${meta.groups.join(' / ')}`;
  if (meta.default) return 'default (tanpa group)';
  if (meta.legacy) return 'legacy (bukan dari Authentik)';
  return '';
}

// Effective default for a role with no saved matrix: the legacy fallback
// (everything that is not adminOnly).
function defaultHrefs() {
  return navItems.filter((it) => !it.adminOnly).map((it) => it.href);
}

export default function MenuAccessPage() {
  const { user, isLoading, mutate } = useUser({ redirectTo: '/login' });
  const isAdmin = user?.role === 'admin';

  // Configurable roles come from the backend (Authentik mapping ∪ DB roles, minus
  // admin), so the editor tracks Authentik and never misses a legacy role.
  const { data: rolesData } = useSWR(isAdmin ? '/api/admin/roles' : null, fetcher);
  const roles = rolesData?.roles?.length ? rolesData.roles : CONFIGURABLE_ROLES;
  const metaByRole = Object.fromEntries((rolesData?.roleMeta || []).map((m) => [m.role, m]));

  // matrix: { role: Set(href) }
  const [matrix, setMatrix] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user) return;
    const saved = user.menu_access || {};
    const next = {};
    for (const role of roles) {
      next[role] = new Set(Array.isArray(saved[role]) ? saved[role] : defaultHrefs());
    }
    setMatrix(next);
  }, [user, rolesData]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(role, href) {
    setMatrix((prev) => {
      const set = new Set(prev[role]);
      set.has(href) ? set.delete(href) : set.add(href);
      return { ...prev, [role]: set };
    });
  }

  function setAll(role, on) {
    setMatrix((prev) => ({ ...prev, [role]: new Set(on ? navItems.map((it) => it.href) : []) }));
  }

  async function save() {
    setSaving(true); setMsg('');
    try {
      const value = {};
      for (const role of roles) value[role] = Array.from(matrix[role] || []);
      await api('/api/admin/settings/menu_access', { method: 'PUT', body: { value } });
      await mutate();
      setMsg('Tersimpan. Menu user lain ikut berubah saat mereka refresh.');
    } catch (e) {
      setMsg('Gagal simpan: ' + (e.message || 'error'));
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !matrix) return <Layout title="Menu Access"><div className="p-6 text-slate-400">Memuat…</div></Layout>;
  if (!isAdmin) return <Layout title="Menu Access"><div className="p-6 text-rose-600">Halaman ini khusus admin.</div></Layout>;

  return (
    <Layout title="Menu Access — Otorisasi Menu">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-slate-800">Otorisasi Menu per Role</h1>
          <p className="text-sm text-slate-500 mt-1">
            Centang menu yang boleh dilihat tiap role. <b>Admin selalu lihat semua menu</b> (tidak bisa dibatasi).
            Role diambil dari Authentik dan tidak bisa diubah di sini.
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-3 py-2 font-semibold text-slate-600">Menu</th>
                {roles.map((role) => (
                  <th key={role} className="px-3 py-2 text-center font-semibold text-slate-600 whitespace-nowrap">
                    <div>{labelFor(role)}</div>
                    {hintFor(metaByRole[role]) && (
                      <div className="text-[10px] font-normal text-slate-400">{hintFor(metaByRole[role])}</div>
                    )}
                    <div className="mt-1 flex items-center justify-center gap-1 text-[10px] font-normal">
                      <button onClick={() => setAll(role, true)} className="text-brand-600 hover:underline">semua</button>
                      <span className="text-slate-300">/</span>
                      <button onClick={() => setAll(role, false)} className="text-slate-400 hover:underline">kosong</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {navItems.map((it) => (
                <tr key={it.href} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="mr-1.5">{it.icon}</span>
                    <span className="text-slate-700">{it.label}</span>
                    <span className="text-slate-400 text-xs ml-1.5">{it.href}</span>
                  </td>
                  {roles.map((role) => (
                    <td key={role} className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        className="w-4 h-4 cursor-pointer accent-brand-600"
                        checked={!!(matrix[role] && matrix[role].has(it.href))}
                        onChange={() => toggle(role, it.href)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-5 py-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
          {msg && <span className="text-sm text-slate-600">{msg}</span>}
        </div>
      </div>
    </Layout>
  );
}
