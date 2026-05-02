// Provider-agnostic AI factory. Settings (DB-backed) override env vars.
//   reply_provider: 'anthropic' | 'openai'
//   ai_credentials: { anthropic: { api_key, model }, openai: { api_key, model } }

const settings = require('./settings');
const claude = require('./claudeClient');
const openai = require('./openaiClient');
const gemini = require('./geminiReplyClient');

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini'];

async function getActiveProvider() {
  const v = await settings.getSetting('reply_provider', null);
  const candidate = (v || process.env.AI_REPLY_PROVIDER || 'anthropic').toLowerCase();
  return VALID_PROVIDERS.includes(candidate) ? candidate : 'anthropic';
}

async function getProviderConfig(provider) {
  const creds = await settings.getSetting('ai_credentials', null);
  const fromDb = creds && creds[provider] ? creds[provider] : {};
  if (provider === 'anthropic') {
    return {
      apiKey: fromDb.api_key || process.env.ANTHROPIC_API_KEY || '',
      model: fromDb.model || process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    };
  }
  if (provider === 'openai') {
    return {
      apiKey: fromDb.api_key || process.env.OPENAI_API_KEY || '',
      model: fromDb.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  if (provider === 'gemini') {
    return {
      apiKey: fromDb.api_key || process.env.GEMINI_API_KEY || '',
      model: fromDb.model || process.env.GEMINI_REPLY_MODEL || 'gemini-2.5-pro',
    };
  }
  throw new Error(`unknown provider: ${provider}`);
}

async function generateWithTools(opts) {
  const provider = await getActiveProvider();
  const providerConfig = await getProviderConfig(provider);
  if (!providerConfig.apiKey) {
    throw new Error(`API key untuk provider "${provider}" belum diset (cek /ai-settings)`);
  }
  // Both clients accept providerConfig hint; claudeClient ignores apiKey/model
  // override in current impl (uses env), so set env temporarily for this call.
  if (provider === 'anthropic') {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevModel = process.env.CLAUDE_MODEL;
    process.env.ANTHROPIC_API_KEY = providerConfig.apiKey;
    process.env.CLAUDE_MODEL = providerConfig.model;
    try {
      return await claude.generateWithTools(opts);
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.CLAUDE_MODEL; else process.env.CLAUDE_MODEL = prevModel;
    }
  }
  if (provider === 'gemini') return gemini.generateWithTools({ ...opts, providerConfig });
  return openai.generateWithTools({ ...opts, providerConfig });
}

async function getActiveStatus() {
  const provider = await getActiveProvider();
  const config = await getProviderConfig(provider);
  return {
    provider,
    model: config.model,
    has_api_key: !!config.apiKey,
  };
}

// Fetch list of available models for a provider. Returns array of
// { id, label, supports_tools? } objects sorted with most-recent first.
async function listProviderModels(provider) {
  const config = await getProviderConfig(provider);
  if (!config.apiKey) {
    return { error: `API key untuk "${provider}" belum diset` };
  }
  if (provider === 'anthropic') return listAnthropicModels(config.apiKey);
  if (provider === 'openai')    return listOpenAiModels(config.apiKey);
  if (provider === 'gemini')    return listGeminiModels(config.apiKey);
  return { error: `unknown provider: ${provider}` };
}

async function listAnthropicModels(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=50', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { error: `Anthropic ${res.status}: ${txt.slice(0, 200)}` };
  }
  const data = await res.json();
  const models = (data.data || []).map((m) => ({
    id: m.id, label: m.display_name || m.id,
  }));
  return { provider: 'anthropic', models };
}

async function listOpenAiModels(apiKey) {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { error: `OpenAI ${res.status}: ${txt.slice(0, 200)}` };
  }
  const data = await res.json();
  // Keep only chat-capable GPT models (filter out embeddings, audio, image, etc.)
  const models = (data.data || [])
    .filter((m) => /^gpt-/i.test(m.id) && !/realtime|audio|tts|transcribe|search|moderation|embedding|image/i.test(m.id))
    .map((m) => ({ id: m.id, label: m.id }))
    .sort((a, b) => b.id.localeCompare(a.id));
  return { provider: 'openai', models };
}

async function listGeminiModels(apiKey) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { error: `Gemini ${res.status}: ${txt.slice(0, 200)}` };
  }
  const data = await res.json();
  // Keep only models that support generateContent + are gemini-* (text/multimodal)
  const models = (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .filter((m) => /gemini/i.test(m.name))
    .filter((m) => !/embedding|aqa|tts|image-generation/i.test(m.name))
    .map((m) => ({
      id: (m.name || '').replace(/^models\//, ''),
      label: m.displayName || m.name,
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
  return { provider: 'gemini', models };
}

// Tool-less completion (no tool-loop). Used by suggestion engine + any other
// path that just needs "input → text". Routes to active provider per setting.
async function complete({ system, messages, max_tokens = 1024, temperature = 0.7 }) {
  const provider = await getActiveProvider();
  const providerConfig = await getProviderConfig(provider);
  if (!providerConfig.apiKey) {
    throw new Error(`API key untuk provider "${provider}" belum diset (cek /ai-settings)`);
  }
  if (provider === 'anthropic') {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = providerConfig.apiKey;
    try {
      return await claude.complete({
        model: providerConfig.model,
        system, messages, max_tokens, temperature,
      });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  }
  if (provider === 'openai') {
    return openaiComplete({ apiKey: providerConfig.apiKey, model: providerConfig.model, system, messages, max_tokens, temperature });
  }
  if (provider === 'gemini') {
    return geminiComplete({ apiKey: providerConfig.apiKey, model: providerConfig.model, system, messages, max_tokens, temperature });
  }
  throw new Error(`provider tidak support complete: ${provider}`);
}

async function openaiComplete({ apiKey, model, system, messages, max_tokens, temperature }) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: msgs, max_tokens, temperature }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return {
    text: d.choices?.[0]?.message?.content?.trim() || '',
    usage: { input_tokens: d.usage?.prompt_tokens || 0, output_tokens: d.usage?.completion_tokens || 0 },
  };
}

async function geminiComplete({ apiKey, model, system, messages, max_tokens, temperature }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));
  const body = {
    contents,
    generationConfig: { maxOutputTokens: max_tokens, temperature },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return {
    text,
    usage: { input_tokens: d.usageMetadata?.promptTokenCount || 0, output_tokens: d.usageMetadata?.candidatesTokenCount || 0 },
  };
}

module.exports = {
  VALID_PROVIDERS,
  getActiveProvider,
  getProviderConfig,
  getActiveStatus,
  generateWithTools,
  complete,
  listProviderModels,
};
