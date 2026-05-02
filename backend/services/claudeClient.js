const Anthropic = require('@anthropic-ai/sdk');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY belum diset');
  client = new Anthropic({ apiKey });
  return client;
}

const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = () => parseInt(process.env.CLAUDE_MAX_TOKENS) || 1024;

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      if (!RETRYABLE.has(status) || attempt === maxAttempts) break;
      const delay = 1000 * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Tool-call loop using Anthropic Messages API.
 */
async function generateWithTools({ systemPrompt, messages, tools, executor, maxIterations = 5 }) {
  const ant = getClient();
  const conversation = [...messages];
  const calls = [];
  let usageIn = 0, usageOut = 0;
  let iterationsCapped = false;

  // Mark system + tools as cacheable so repeated calls within ~5min hit prompt cache.
  // Persona + KB block stable; message history is the variable part.
  const systemBlocks = systemPrompt
    ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
    : undefined;
  const toolsParam = tools.length
    ? tools.map((t, idx) => idx === tools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } } : t)
    : undefined;

  for (let i = 0; i < maxIterations + 1; i++) {
    const resp = await withRetry(() => ant.messages.create({
      model: MODEL(),
      max_tokens: MAX_TOKENS(),
      system: systemBlocks,
      tools: toolsParam,
      messages: conversation,
    }));

    usageIn += resp.usage?.input_tokens || 0;
    usageOut += resp.usage?.output_tokens || 0;

    const textBlocks = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text);
    const text = textBlocks.join('').trim();

    const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { text, calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
    }

    if (i === maxIterations) {
      iterationsCapped = true;
      return { text: text || '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
    }

    conversation.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const tu of toolUses) {
      const callRecord = { id: tu.id, name: tu.name, args: tu.input || {} };
      try {
        const result = await executor(tu.name, tu.input || {});
        callRecord.result = result;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result ?? null),
        });
      } catch (err) {
        callRecord.error = err?.message || 'tool execution failed';
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: callRecord.error,
        });
      }
      calls.push(callRecord);
    }

    conversation.push({ role: 'user', content: toolResults });
  }

  return { text: '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped: true };
}

/**
 * Simple one-shot completion with no tools. Thin wrapper for use cases like
 * suggestion synthesis, summarisation, etc.
 */
async function complete({ model, system, messages, max_tokens = 1024, temperature = 0.7 }) {
  const ant = getClient();
  const sysBlock = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;
  const resp = await withRetry(() => ant.messages.create({
    model: model || MODEL(),
    max_tokens,
    temperature,
    system: sysBlock,
    messages,
  }));
  const text = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('').trim();
  return {
    text,
    usage: { input_tokens: resp.usage?.input_tokens || 0, output_tokens: resp.usage?.output_tokens || 0 },
  };
}

module.exports = { generateWithTools, complete, getClient };
