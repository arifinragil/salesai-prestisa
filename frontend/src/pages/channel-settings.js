import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import { useToast } from '@/components/Toast';

const URL_FIELDS = [
  {
    key: 'inbound_webhook_url',
    label: 'Inbound webhook URL',
    hint: 'URL yang dipanggil oleh provider (Meta / WAHA) ketika ada pesan masuk dari customer. Daftarkan URL ini di dashboard Meta Cloud API → Configuration → Callback URL.',
    placeholder: 'https://salesai.prestisa.net/webhook/wa/inbound',
  },
  {
    key: 'outbound_webhook_url',
    label: 'Outbound webhook URL',
    hint: 'Endpoint yang dipakai sistem untuk mengirim balasan keluar. Untuk Meta Cloud API biasanya: https://graph.facebook.com/v20.0/{phone_number_id}/messages',
    placeholder: 'https://graph.facebook.com/v20.0/PHONE_NUMBER_ID/messages',
  },
  {
    key: 'status_webhook_url',
    label: 'Status report webhook URL',
    hint: 'URL untuk menerima status delivery / read / failed dari Meta. Biasanya sama dengan inbound webhook (Meta kirim ke 1 callback URL untuk semua event).',
    placeholder: 'https://salesai.prestisa.net/webhook/wa/status',
  },
];

const META_FIELDS = [
  { key: 'meta_phone_number_id', label: 'Phone Number ID', placeholder: '102290129...' },
  { key: 'meta_waba_id',         label: 'WABA ID',         placeholder: '105954015...' },
];

const SECRET_FIELDS = [
  { key: 'meta_access_token',  label: 'Permanent Access Token', hint: 'System User token dari Business Manager (tidak akan expired).' },
  { key: 'meta_app_secret',    label: 'App Secret',             hint: 'Untuk verifikasi signature X-Hub-Signature-256 dari Meta.' },
  { key: 'meta_verify_token',  label: 'Webhook Verify Token',   hint: 'String bebas yang dipakai Meta saat hand-shake webhook (GET /webhook?hub.verify_token=...).' },
];

const WAHA_FIELDS = [
  { key: 'waha_api_url', label: 'WAHA API URL',     placeholder: 'http://localhost:3000' },
  { key: 'waha_session', label: 'WAHA Session name', placeholder: 'tiara-pilot' },
];

const WAHA_SECRETS = [
  { key: 'waha_api_key',   label: 'WAHA API Key' },
  { key: 'webhook_secret', label: 'Webhook Secret (X-Webhook-Hmac)' },
];

export default function ChannelSettingsPage() {
  const { data, error, mutate } = useSWR('/api/admin/settings', fetcher);
  const toast = useToast();
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  const current = useMemo(() => {
    const it = (data?.items || []).find((x) => x.key === 'channel_settings');
    return it?.value || {};
  }, [data]);

  useEffect(() => {
    setForm({});
  }, [current]);

  function fld(key) {
    return form[key] !== undefined ? form[key] : (current[key] && typeof current[key] === 'object' ? '' : (current[key] || ''));
  }
  function setFld(key, v) {
    setForm((f) => ({ ...f, [key]: v }));
  }

  function secretInfo(key) {
    const v = current[key];
    if (v && typeof v === 'object' && v.set) return `tersimpan (${v.preview})`;
    return null;
  }

  async function save() {
    const payload = {};
    for (const k of Object.keys(form)) {
      const v = form[k];
      if (v === '' || v == null) continue;
      payload[k] = v;
    }
    if (form.provider !== undefined) payload.provider = form.provider;
    if (Object.keys(payload).length === 0) {
      toast.info('Tidak ada perubahan');
      return;
    }
    setSaving(true);
    try {
      await api('/api/admin/settings/channel_settings', { method: 'PUT', body: { value: payload } });
      toast.success('Channel settings tersimpan');
      setForm({});
      mutate();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  const provider = form.provider !== undefined ? form.provider : (current.provider || 'waha');

  return (
    <Layout title="Channel Settings — Tiara">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Inbox Channel</h1>
          <p className="text-sm text-slate-500 mt-1">
            Konfigurasi integrasi WhatsApp. Untuk pilot pakai WAHA self-hosted, untuk production bisa pindah ke Meta Cloud API tanpa ubah kode (provider abstraction).
          </p>
          {error && <div className="text-sm text-rose-600 mt-2">Gagal memuat: {error.message}</div>}
        </div>

        <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="text-sm font-semibold text-slate-700">Provider</div>
          <div className="flex gap-2">
            {['waha', 'metaCloud'].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setFld('provider', p)}
                className={`px-3 py-2 text-sm rounded-md border ${provider === p ? 'bg-brand-500 border-brand-500 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
              >
                {p === 'waha' ? 'WAHA (self-hosted)' : 'Meta Cloud API'}
              </button>
            ))}
          </div>
          <div className="text-xs text-slate-500">
            Aktif di runtime: <code className="bg-slate-100 px-1.5 py-0.5 rounded">WA_PROVIDER={current.provider || 'waha'}</code>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
          <div className="text-sm font-semibold text-slate-700">Webhook URLs</div>
          {URL_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-slate-600 mb-1">{f.label}</label>
              <input
                type="url"
                value={fld(f.key)}
                onChange={(e) => setFld(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono focus:outline-none focus:border-brand-500"
              />
              <p className="text-[11px] text-slate-500 mt-1">{f.hint}</p>
            </div>
          ))}
        </section>

        {provider === 'metaCloud' && (
          <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
            <div className="text-sm font-semibold text-slate-700">Meta Cloud API</div>
            {META_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">{f.label}</label>
                <input
                  type="text"
                  value={fld(f.key)}
                  onChange={(e) => setFld(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono focus:outline-none focus:border-brand-500"
                />
              </div>
            ))}
            {SECRET_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {f.label}
                  {secretInfo(f.key) && <span className="ml-2 text-emerald-600 font-normal">· {secretInfo(f.key)}</span>}
                </label>
                <input
                  type="password"
                  value={fld(f.key)}
                  onChange={(e) => setFld(f.key, e.target.value)}
                  placeholder={secretInfo(f.key) ? 'kosongkan untuk pakai yang tersimpan' : 'masukkan rahasia…'}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono focus:outline-none focus:border-brand-500"
                />
                {f.hint && <p className="text-[11px] text-slate-500 mt-1">{f.hint}</p>}
              </div>
            ))}
          </section>
        )}

        {provider === 'waha' && (
          <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
            <div className="text-sm font-semibold text-slate-700">WAHA</div>
            {WAHA_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">{f.label}</label>
                <input
                  type="text"
                  value={fld(f.key)}
                  onChange={(e) => setFld(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono focus:outline-none focus:border-brand-500"
                />
              </div>
            ))}
            {WAHA_SECRETS.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {f.label}
                  {secretInfo(f.key) && <span className="ml-2 text-emerald-600 font-normal">· {secretInfo(f.key)}</span>}
                </label>
                <input
                  type="password"
                  value={fld(f.key)}
                  onChange={(e) => setFld(f.key, e.target.value)}
                  placeholder={secretInfo(f.key) ? 'kosongkan untuk pakai yang tersimpan' : 'masukkan rahasia…'}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md font-mono focus:outline-none focus:border-brand-500"
                />
              </div>
            ))}
          </section>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40"
          >
            {saving ? 'Menyimpan…' : 'Simpan'}
          </button>
          <span className="text-xs text-slate-500">
            Field rahasia kosong = pakai nilai tersimpan. Restart backend untuk mengaktifkan provider switch (env <code>WA_PROVIDER</code>).
          </span>
        </div>
      </div>
    </Layout>
  );
}
