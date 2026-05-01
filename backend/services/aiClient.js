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

module.exports = {
  VALID_PROVIDERS,
  getActiveProvider,
  getProviderConfig,
  getActiveStatus,
  generateWithTools,
};
