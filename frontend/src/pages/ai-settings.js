import { useEffect, useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import { useToast } from '@/components/Toast';
import { formatRelative } from '@/lib/format';

function ModelPicker({ provider, value, placeholder, models, loading, onLoad, onChange }) {
  const hasModels = Array.isArray(models);
  return (
    <div className="mb-2">
      {!hasModels ? (
        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          className="w-full px-2 py-1.5 text-sm border border-dashed border-slate-300 rounded text-slate-500 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? 'Loading…' : `Load ${provider} models from API`}
        </button>
      ) : (
        <div className="flex gap-1">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-slate-200 rounded bg-white font-mono"
          >
            <option value="">— pakai default ({placeholder}) —</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={onLoad}
            disabled={loading}
            title="Refresh"
            className="px-2 py-1.5 text-sm border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
          >
            ↻
          </button>
        </div>
      )}
    </div>
  );
}

export default function AiSettings() {
  const toast = useToast();
  const personas = useSWR('/api/admin/personas', fetcher);
  const aiGlobal = useSWR('/api/admin/ai/global', fetcher, { refreshInterval: 30_000 });
  const settings = useSWR('/api/admin/settings', fetcher);
  const aiProvider = useSWR('/api/admin/ai/provider', fetcher);

  const [selectedId, setSelectedId] = useState(null);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);

  // AI provider edit state
  const [providerDraft, setProviderDraft] = useState('');
  const [anthroKey, setAnthroKey] = useState('');
  const [anthroModel, setAnthroModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [models, setModels] = useState({}); // { anthropic: [...], openai: [...], gemini: [...] }
  const [loadingModels, setLoadingModels] = useState({});

  async function loadModels(provider) {
    if (loadingModels[provider]) return;
    setLoadingModels((s) => ({ ...s, [provider]: true }));
    try {
      const r = await api(`/api/admin/ai/models?provider=${provider}`);
      setModels((s) => ({ ...s, [provider]: r.models || [] }));
    } catch (e) {
      toast.error(`Load ${provider} models: ${e.message}`);
    } finally {
      setLoadingModels((s) => ({ ...s, [provider]: false }));
    }
  }

  // Load full text of selected persona
  const personaDetail = useSWR(
    selectedId ? `/api/admin/personas/${selectedId}` : null,
    fetcher
  );
  useEffect(() => {
    if (personaDetail.data?.persona) {
      setDraftPrompt(personaDetail.data.persona.prompt_text || '');
      setDraftName(personaDetail.data.persona.name + '_' + new Date().toISOString().slice(0, 10));
    }
  }, [personaDetail.data]);

  async function activate(id) {
    if (!confirm('Activate persona ini? Persona aktif sebelumnya akan di-deactivate.')) return;
    setBusy(true);
    try {
      await api(`/api/admin/personas/${id}/activate`, { method: 'POST' });
      toast.success('Persona activated');
      personas.mutate();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function saveAsNewVersion() {
    if (!draftName.trim() || !draftPrompt.trim()) {
      toast.error('Name dan prompt wajib');
      return;
    }
    setBusy(true);
    try {
      const r = await api('/api/admin/personas', {
        method: 'POST',
        body: { name: draftName.trim(), prompt_text: draftPrompt },
      });
      toast.success(`Saved as new version (#${r.id}). Belum activate — klik Activate untuk pakai.`);
      personas.mutate();
      setSelectedId(r.id);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  async function toggleAi() {
    const enabled = !aiGlobal.data?.enabled;
    try {
      await api('/api/admin/ai/global', { method: 'POST', body: { enabled } });
      toast.success('AI global ' + (enabled ? 'ON' : 'OFF'));
      aiGlobal.mutate();
    } catch (e) { toast.error(e.message); }
  }

  function getSetting(key, fallback) {
    const item = settings.data?.items?.find((i) => i.key === key);
    return item ? item.value : fallback;
  }

  async function saveSetting(key, value) {
    try {
      await api(`/api/admin/settings/${key}`, { method: 'PUT', body: { value } });
      toast.success(`${key} saved`);
      settings.mutate();
    } catch (e) { toast.error(e.message); }
  }

  async function saveProvider() {
    if (!providerDraft) return;
    try {
      await api('/api/admin/settings/reply_provider', { method: 'PUT', body: { value: providerDraft } });
      toast.success(`Active provider: ${providerDraft}`);
      aiProvider.mutate();
      setProviderDraft('');
    } catch (e) { toast.error(e.message); }
  }

  async function saveCredentials(provider, apiKey, model) {
    try {
      const body = {
        value: { [provider]: { api_key: apiKey || undefined, model: model || undefined } },
      };
      await api('/api/admin/settings/ai_credentials', { method: 'PUT', body });
      toast.success(`${provider} credentials saved`);
      settings.mutate();
      aiProvider.mutate();
      // Clear input fields after save
      if (provider === 'anthropic') { setAnthroKey(''); setAnthroModel(''); }
      if (provider === 'openai')    { setOpenaiKey(''); setOpenaiModel(''); }
      if (provider === 'gemini')    { setGeminiKey(''); setGeminiModel(''); }
    } catch (e) { toast.error(e.message); }
  }

  const credentials = getSetting('ai_credentials', {});
  const activeProvider = aiProvider.data?.provider || 'anthropic';
  const activeModel = aiProvider.data?.model || '';
  const webhook = getSetting('handover_webhook', null);

  // Sync local edit state with stored when first loaded
  useEffect(() => {
    if (webhook && !webhookUrl) {
      setWebhookUrl(webhook.url || '');
      setWebhookEnabled(webhook.enabled !== false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(webhook)]);

  async function saveWebhook() {
    try {
      await api('/api/admin/settings/handover_webhook', {
        method: 'PUT',
        body: { value: { url: webhookUrl, enabled: webhookEnabled } },
      });
      toast.success('Webhook saved');
      settings.mutate();
    } catch (e) { toast.error(e.message); }
  }

  async function testWebhook() {
    if (!webhookUrl) return toast.error('URL kosong');
    setWebhookTesting(true);
    try {
      await api('/api/admin/webhook/test', { method: 'POST', body: { url: webhookUrl } });
      toast.success('Test message terkirim — cek Slack/Discord channel');
    } catch (e) { toast.error('Test gagal: ' + e.message); }
    finally { setWebhookTesting(false); }
  }

  return (
    <Layout title="Persona & Settings — Tiara">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
        <h1 className="text-lg font-semibold text-slate-800">Persona & Settings</h1>

        <OpsSettingsCard
          getSetting={getSetting}
          saveSetting={saveSetting}
          mutateSettings={() => settings.mutate()}
          toast={toast}
        />

        {/* AI Provider */}
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-700">AI Provider</h2>
              <div className="text-xs text-slate-500 mt-1">
                Active: <span className="font-medium text-slate-800">{activeProvider}</span>
                {' · '}
                Model: <span className="font-mono text-slate-700">{activeModel}</span>
                {' · '}
                {aiProvider.data?.has_api_key
                  ? <span className="text-emerald-600">key set ✓</span>
                  : <span className="text-rose-600">key MISSING — AI tidak bisa reply</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={providerDraft || activeProvider}
                onChange={(e) => setProviderDraft(e.target.value)}
                className="px-3 py-1.5 text-sm border border-slate-200 rounded bg-white"
              >
                {(aiProvider.data?.valid_providers || ['anthropic', 'openai']).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                onClick={saveProvider}
                disabled={!providerDraft || providerDraft === activeProvider}
                className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40"
              >
                Switch active
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {/* Anthropic */}
            <div className="border border-slate-200 rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-slate-700 text-sm">Anthropic (Claude)</div>
                {credentials?.anthropic?.api_key_set && (
                  <span className="text-xs text-emerald-600" title={credentials.anthropic.api_key_preview}>
                    ✓ {credentials.anthropic.api_key_preview}
                  </span>
                )}
              </div>
              <input
                type="password"
                value={anthroKey}
                onChange={(e) => setAnthroKey(e.target.value)}
                placeholder="sk-ant-... (kosongin = jangan ubah)"
                className="w-full mb-2 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono"
              />
              <ModelPicker
                provider="anthropic"
                value={anthroModel}
                placeholder={credentials?.anthropic?.model || 'claude-sonnet-4-6'}
                models={models.anthropic}
                loading={loadingModels.anthropic}
                onLoad={() => loadModels('anthropic')}
                onChange={setAnthroModel}
              />
              <button
                onClick={() => saveCredentials('anthropic', anthroKey, anthroModel)}
                disabled={!anthroKey && !anthroModel}
                className="text-sm px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40"
              >
                Save
              </button>
            </div>

            {/* OpenAI */}
            <div className="border border-slate-200 rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-slate-700 text-sm">OpenAI (GPT)</div>
                {credentials?.openai?.api_key_set && (
                  <span className="text-xs text-emerald-600" title={credentials.openai.api_key_preview}>
                    ✓ {credentials.openai.api_key_preview}
                  </span>
                )}
              </div>
              <input
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-... (kosongin = jangan ubah)"
                className="w-full mb-2 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono"
              />
              <ModelPicker
                provider="openai"
                value={openaiModel}
                placeholder={credentials?.openai?.model || 'gpt-4o-mini'}
                models={models.openai}
                loading={loadingModels.openai}
                onLoad={() => loadModels('openai')}
                onChange={setOpenaiModel}
              />
              <button
                onClick={() => saveCredentials('openai', openaiKey, openaiModel)}
                disabled={!openaiKey && !openaiModel}
                className="text-sm px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40"
              >
                Save
              </button>
            </div>

            {/* Gemini */}
            <div className="border border-slate-200 rounded-md p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-slate-700 text-sm">Google Gemini</div>
                {credentials?.gemini?.api_key_set && (
                  <span className="text-xs text-emerald-600" title={credentials.gemini.api_key_preview}>
                    ✓ {credentials.gemini.api_key_preview}
                  </span>
                )}
              </div>
              <input
                type="password"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIza... (kosongin = jangan ubah)"
                className="w-full mb-2 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono"
              />
              <ModelPicker
                provider="gemini"
                value={geminiModel}
                placeholder={credentials?.gemini?.model || 'gemini-2.5-pro'}
                models={models.gemini}
                loading={loadingModels.gemini}
                onLoad={() => loadModels('gemini')}
                onChange={setGeminiModel}
              />
              <button
                onClick={() => saveCredentials('gemini', geminiKey, geminiModel)}
                disabled={!geminiKey && !geminiModel}
                className="text-sm px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-40"
              >
                Save
              </button>
              <div className="text-xs text-slate-400 mt-2">
                Note: classifier juga pakai key Gemini (env). Untuk reply, key ini boleh sama atau beda.
              </div>
            </div>
          </div>
        </div>

        {/* Quick toggles */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase mb-1">Global AI</div>
            <div className="flex items-center justify-between">
              <span className={`status-pill ${aiGlobal.data?.enabled ? 'status-active' : 'status-handover'}`}>
                {aiGlobal.data?.enabled ? 'ON' : 'OFF'}
              </span>
              <button
                onClick={toggleAi}
                className="text-sm px-3 py-1 rounded-md bg-white border border-slate-200 hover:bg-slate-50"
              >
                Toggle
              </button>
            </div>
            <div className="text-xs text-slate-400 mt-2">
              Kill switch — bukan persistent (reset saat backend restart).
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase mb-1">Daily cost cap (USD)</div>
            <div className="flex items-center gap-2">
              <input
                type="number" step="0.5" min="0"
                defaultValue={getSetting('daily_cost_cap_usd', 5)}
                onBlur={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v >= 0) saveSetting('daily_cost_cap_usd', v);
                }}
                className="w-24 px-2 py-1 border border-slate-200 rounded text-sm"
              />
              <span className="text-xs text-slate-400">save on blur</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase mb-1">Handover webhook (Slack/Discord)</div>
            <div className="space-y-2">
              <input
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.slack.com/... atau discord.com/api/webhooks/..."
                className="w-full px-2 py-1 text-xs border border-slate-200 rounded font-mono"
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1 text-xs text-slate-600">
                  <input type="checkbox" checked={webhookEnabled} onChange={(e) => setWebhookEnabled(e.target.checked)} />
                  enabled
                </label>
                <div className="flex gap-1">
                  <button
                    onClick={testWebhook}
                    disabled={!webhookUrl || webhookTesting}
                    className="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {webhookTesting ? '…' : 'Test'}
                  </button>
                  <button
                    onClick={saveWebhook}
                    className="text-xs px-2 py-1 rounded bg-slate-700 text-white hover:bg-slate-800"
                  >
                    Save
                  </button>
                </div>
              </div>
              {webhook?.url && (
                <div className="text-[10px] text-slate-400 truncate" title={webhook.url}>
                  Saved: {webhook.url.slice(0, 50)}…
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 uppercase mb-1">Shadow default (new conv)</div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!getSetting('shadow_mode_default', false)}
                onChange={(e) => saveSetting('shadow_mode_default', e.target.checked)}
              />
              <span className="text-sm text-slate-700">Conv baru auto shadow</span>
            </label>
          </div>
        </div>

        {/* Persona list + editor */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">
              Persona versions
            </div>
            <ul className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
              {(personas.data?.items || []).map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 ${
                      selectedId === p.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-800">{p.name}</span>
                      {p.active && <span className="status-pill status-active">active</span>}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {formatRelative(p.created_at)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="md:col-span-2 bg-white border border-slate-200 rounded-lg p-4 flex flex-col">
            {!selectedId ? (
              <div className="text-sm text-slate-400 py-12 text-center">
                Pilih persona di kiri untuk lihat / edit. Edit selalu bikin versi baru — tidak override.
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="Name versi baru (mis. tiara_v2)"
                    className="flex-1 mr-3 px-3 py-1.5 text-sm border border-slate-200 rounded"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={saveAsNewVersion}
                      disabled={busy}
                      className="text-sm px-3 py-1.5 rounded-md bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      Save as new version
                    </button>
                    {personaDetail.data?.persona && !personaDetail.data.persona.active && (
                      <button
                        onClick={() => activate(selectedId)}
                        disabled={busy}
                        className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50"
                      >
                        Activate this version
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  className="flex-1 min-h-[400px] font-mono text-sm border border-slate-200 rounded p-3 focus:outline-none focus:border-brand-500"
                  spellCheck={false}
                />
                <div className="text-xs text-slate-400 mt-2">
                  {draftPrompt.length} chars · System akan inject konteks dinamis (history, customer profile) di akhir prompt sebelum dikirim ke Claude.
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}

function ChannelInput({ label, hint, value, onChange, onTest, testing, canTest }) {
  return (
    <label className="text-xs text-slate-600 space-y-1 block">
      <div>{label} <span className="text-slate-400">— {hint}</span></div>
      <div className="flex gap-1">
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="(kosong = pakai default)"
          className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
        <button type="button" onClick={onTest} disabled={testing || !canTest}
          className="text-xs px-2 py-1.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-40">
          {testing ? '…' : 'Test'}
        </button>
      </div>
    </label>
  );
}

function OpsSettingsCard({ getSetting, saveSetting, mutateSettings, toast }) {
  const [tgToken, setTgToken] = useState('');
  const [tgChat, setTgChat] = useState('');
  const [tgChatSla, setTgChatSla] = useState('');
  const [tgChatAnomaly, setTgChatAnomaly] = useState('');
  const [tgChatBrief, setTgChatBrief] = useState('');
  const [sla, setSla] = useState('15');
  const [briefEnabled, setBriefEnabled] = useState(true);
  const [briefTime, setBriefTime] = useState('09:00');
  const [anomalyEnabled, setAnomalyEnabled] = useState(true);
  const [claimMin, setClaimMin] = useState('5');
  const [spamEnabled, setSpamEnabled] = useState(true);
  const [testing, setTesting] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    setTgToken(getSetting('telegram_bot_token', '') || '');
    setTgChat(getSetting('telegram_chat_id', '') || '');
    setTgChatSla(getSetting('telegram_chat_sla', '') || '');
    setTgChatAnomaly(getSetting('telegram_chat_anomaly', '') || '');
    setTgChatBrief(getSetting('telegram_chat_brief', '') || '');
    setSla(String(getSetting('sla_handover_minutes', 15) ?? 15));
    setBriefEnabled(getSetting('daily_brief_enabled', true) !== false);
    setBriefTime(getSetting('daily_brief_time', '09:00') || '09:00');
    setAnomalyEnabled(getSetting('anomaly_alerts_enabled', true) !== false);
    setClaimMin(String(getSetting('claim_lease_minutes', 5) ?? 5));
    setSpamEnabled(getSetting('spam_filter_enabled', true) !== false);
    setHydrated(true);
  }, [getSetting, hydrated]);

  async function saveAll() {
    try {
      await saveSetting('telegram_bot_token', tgToken.trim());
      await saveSetting('telegram_chat_id', tgChat.trim());
      await saveSetting('telegram_chat_sla', tgChatSla.trim());
      await saveSetting('telegram_chat_anomaly', tgChatAnomaly.trim());
      await saveSetting('telegram_chat_brief', tgChatBrief.trim());
      await saveSetting('sla_handover_minutes', parseInt(sla) || 15);
      await saveSetting('daily_brief_enabled', !!briefEnabled);
      await saveSetting('daily_brief_time', briefTime || '09:00');
      await saveSetting('anomaly_alerts_enabled', !!anomalyEnabled);
      await saveSetting('claim_lease_minutes', parseInt(claimMin) || 5);
      await saveSetting('spam_filter_enabled', !!spamEnabled);
      mutateSettings();
      toast.success('Ops settings saved');
    } catch (e) { toast.error(e.message); }
  }

  async function testTelegram(kind) {
    setTesting(kind || 'default');
    try {
      const r = await api('/api/admin/telegram/test', { method: 'POST', body: kind ? { kind } : {} });
      toast.success(`Bot @${r.bot.username} OK — kirim ke ${r.chat_id}`);
    } catch (e) { toast.error('Telegram test gagal: ' + e.message); }
    finally { setTesting(false); }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
      <h2 className="text-sm font-semibold text-slate-700">Operasional & Notifikasi</h2>

      <div>
        <h3 className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Telegram bot (alert + daily brief)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-xs text-slate-600 space-y-1">
            <div>Bot token <span className="text-slate-400">(dari @BotFather)</span></div>
            <input value={tgToken} onChange={(e) => setTgToken(e.target.value)}
              placeholder="123456:ABC..." spellCheck={false}
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
          </label>
          <label className="text-xs text-slate-600 space-y-1">
            <div>Chat ID default <span className="text-slate-400">(fallback semua jenis)</span></div>
            <div className="flex gap-1">
              <input value={tgChat} onChange={(e) => setTgChat(e.target.value)}
                placeholder="-1001234567890 atau 987654321"
                className="flex-1 px-2 py-1.5 text-sm border border-slate-200 rounded font-mono" />
              <button type="button" onClick={() => testTelegram(null)} disabled={testing || !tgToken.trim() || !tgChat.trim()}
                className="text-xs px-2 py-1.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50">
                {testing === 'default' ? '…' : 'Test'}
              </button>
            </div>
          </label>
        </div>

        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
          <ChannelInput label="🚨 SLA breach" hint="Tim operator" value={tgChatSla} onChange={setTgChatSla}
            onTest={() => testTelegram('sla')} testing={testing === 'sla'} canTest={!!tgToken.trim()} />
          <ChannelInput label="📈 Anomaly alert" hint="Tim oncall/dev" value={tgChatAnomaly} onChange={setTgChatAnomaly}
            onTest={() => testTelegram('anomaly')} testing={testing === 'anomaly'} canTest={!!tgToken.trim()} />
          <ChannelInput label="📊 Daily brief" hint="Owner / manajemen" value={tgChatBrief} onChange={setTgChatBrief}
            onTest={() => testTelegram('brief')} testing={testing === 'brief'} canTest={!!tgToken.trim()} />
        </div>
        <div className="mt-2 text-[11px] text-slate-400">
          Field channel-specific kosong → fallback ke Chat ID default. Tip: dapatkan chat ID via <code>@userinfobot</code> di Telegram.
        </div>
      </div>

      <div className="border-t border-slate-100 pt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="text-xs text-slate-600 space-y-1">
          <div>SLA handover (menit)</div>
          <input type="number" min={1} max={1440} value={sla} onChange={(e) => setSla(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
          <div className="text-[10px] text-slate-400">Handover open lebih lama dari ini → Telegram alert.</div>
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <div>Claim lease (menit)</div>
          <input type="number" min={1} max={120} value={claimMin} onChange={(e) => setClaimMin(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
          <div className="text-[10px] text-slate-400">Operator yang claim conv punya hak balas selama X menit.</div>
        </label>
        <label className="text-xs text-slate-600 space-y-1">
          <div>Daily brief jam</div>
          <input type="time" value={briefTime} onChange={(e) => setBriefTime(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
          <div className="text-[10px] text-slate-400">Cron tetap pakai jam ini sebagai panduan (set juga di /etc/cron.d).</div>
        </label>
      </div>

      <div className="border-t border-slate-100 pt-4 flex flex-wrap gap-4">
        <label className="text-xs text-slate-600 inline-flex items-center gap-2">
          <input type="checkbox" checked={briefEnabled} onChange={(e) => setBriefEnabled(e.target.checked)} /> Daily brief enabled
        </label>
        <label className="text-xs text-slate-600 inline-flex items-center gap-2">
          <input type="checkbox" checked={anomalyEnabled} onChange={(e) => setAnomalyEnabled(e.target.checked)} /> Anomaly alerts
        </label>
        <label className="text-xs text-slate-600 inline-flex items-center gap-2">
          <input type="checkbox" checked={spamEnabled} onChange={(e) => setSpamEnabled(e.target.checked)} /> Spam filter
        </label>
      </div>

      <div className="border-t border-slate-100 pt-4 flex justify-end">
        <button onClick={saveAll}
          className="text-sm px-4 py-2 rounded-md bg-brand-500 text-white hover:bg-brand-600">
          Simpan Ops settings
        </button>
      </div>
    </div>
  );
}
