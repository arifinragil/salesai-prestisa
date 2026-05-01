// OpenAI provider with same generateWithTools interface as claudeClient.
// Uses fetch directly (no SDK dependency) against the Chat Completions API.

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err?.status || err?.response?.status;
      if (!RETRYABLE.has(status) || attempt === maxAttempts) break;
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// Convert Anthropic-style tool declarations (input_schema) to OpenAI tool format
function anthropicToolsToOpenAi(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// Convert Anthropic-style messages array (where assistant content can be array
// with tool_use blocks, and user content can be array with tool_result blocks)
// into OpenAI chat format.
function anthropicToOpenAiMessages(systemPrompt, messages) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      // tool_result blocks → push as separate `tool` messages
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        }
      }
    } else {
      out.push({ role: m.role, content: String(m.content || '') });
    }
  }
  return out;
}

async function chatCompletion({ apiKey, model, messages, tools, max_tokens }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, messages,
      tools: tools && tools.length ? tools : undefined,
      tool_choice: tools && tools.length ? 'auto' : undefined,
      max_tokens,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const e = new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function generateWithTools({ systemPrompt, messages, tools, executor, maxIterations = 5, providerConfig }) {
  const apiKey = providerConfig?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY belum diset');
  const model = providerConfig?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS) || 1024;

  const oaTools = anthropicToolsToOpenAi(tools);
  const conversation = anthropicToOpenAiMessages(systemPrompt, messages);
  const calls = [];
  let usageIn = 0, usageOut = 0;
  let iterationsCapped = false;

  for (let i = 0; i < maxIterations + 1; i++) {
    const resp = await withRetry(() =>
      chatCompletion({ apiKey, model, messages: conversation, tools: oaTools, max_tokens: maxTokens })
    );

    usageIn += resp.usage?.prompt_tokens || 0;
    usageOut += resp.usage?.completion_tokens || 0;

    const choice = resp.choices?.[0];
    const message = choice?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (!toolCalls.length || choice?.finish_reason !== 'tool_calls') {
      return {
        text: (message.content || '').trim(),
        calls,
        usage: { input_tokens: usageIn, output_tokens: usageOut },
        iterationsCapped,
      };
    }

    if (i === maxIterations) {
      iterationsCapped = true;
      return {
        text: (message.content || '').trim(),
        calls,
        usage: { input_tokens: usageIn, output_tokens: usageOut },
        iterationsCapped,
      };
    }

    // Echo assistant message back into conversation
    conversation.push({
      role: 'assistant',
      content: message.content || null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const fn = tc.function || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch {}
      const callRecord = { id: tc.id, name: fn.name, args };
      try {
        const result = await executor(fn.name, args);
        callRecord.result = result;
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result ?? null),
        });
      } catch (err) {
        callRecord.error = err?.message || 'tool execution failed';
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: callRecord.error,
        });
      }
      calls.push(callRecord);
    }
  }

  return { text: '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped: true };
}

module.exports = { generateWithTools, anthropicToolsToOpenAi, anthropicToOpenAiMessages };
