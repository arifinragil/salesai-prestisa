// Gemini provider for REPLY (separate from geminiClient.js which only does
// classification). Uses @google/generative-ai SDK with function calling.

const { GoogleGenerativeAI } = require('@google/generative-ai');

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseStatus = (err) => {
  const m = String(err?.message || '').match(/\[(\d{3}) /);
  return m ? parseInt(m[1]) : (err?.status || null);
};

async function withRetry(fn, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = parseStatus(err);
      if (!RETRYABLE.has(status) || attempt === maxAttempts) break;
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// Convert Anthropic-style input_schema (JSON Schema) to Gemini function
// declaration format (OpenAPI-ish). Gemini also accepts JSON Schema with
// uppercase types in some SDK versions; lowercase works on current SDK.
function anthropicToolsToGemini(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema || { type: 'object', properties: {} },
  }));
}

// Convert our normalized message array (Anthropic-shape) to Gemini history
function anthropicToGeminiHistory(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? [{ text: m.content }] : null;
      if (content) {
        out.push({ role: 'user', parts: content });
      } else if (Array.isArray(m.content)) {
        // tool_result blocks
        const parts = m.content
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({
            functionResponse: {
              name: b._toolName || 'tool',
              response: typeof b.content === 'string'
                ? (() => { try { return JSON.parse(b.content); } catch { return { result: b.content }; } })()
                : (b.content || {}),
            },
          }));
        if (parts.length) out.push({ role: 'user', parts });
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ role: 'model', parts: [{ text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const b of m.content) {
          if (b.type === 'text') parts.push({ text: b.text });
          else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
        }
        if (parts.length) out.push({ role: 'model', parts });
      }
    }
  }
  return out;
}

async function generateWithTools({ systemPrompt, messages, tools, executor, maxIterations = 5, providerConfig }) {
  const apiKey = providerConfig?.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY belum diset');
  const modelName = providerConfig?.model || process.env.GEMINI_REPLY_MODEL || 'gemini-2.5-pro';

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt,
    tools: tools.length ? [{ functionDeclarations: anthropicToolsToGemini(tools) }] : undefined,
  });

  // Gemini chat takes initial history minus the current turn; the current user
  // message is sent via sendMessage. Split the conversation accordingly.
  const fullHistory = anthropicToGeminiHistory(messages);
  let initialHistory = fullHistory.slice(0, -1);
  let currentTurn = fullHistory[fullHistory.length - 1];
  if (!currentTurn) {
    currentTurn = { role: 'user', parts: [{ text: '(no message)' }] };
    initialHistory = [];
  }
  if (currentTurn.role !== 'user') {
    // Edge case — last message is assistant; just send a placeholder
    initialHistory = fullHistory;
    currentTurn = { role: 'user', parts: [{ text: 'lanjutkan' }] };
  }

  const calls = [];
  let usageIn = 0, usageOut = 0;
  let iterationsCapped = false;

  return withRetry(async () => {
    const chat = model.startChat({ history: initialHistory });
    let result = await chat.sendMessage(currentTurn.parts);

    for (let i = 0; i < maxIterations + 1; i++) {
      const resp = result.response;
      // Usage stats — Gemini SDK exposes usageMetadata
      const usage = resp.usageMetadata || {};
      usageIn += usage.promptTokenCount || 0;
      usageOut += usage.candidatesTokenCount || 0;

      const fnCalls = resp.functionCalls?.() || [];
      const text = (resp.text?.() || '').trim();

      if (!fnCalls.length) {
        return { text, calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
      }

      if (i === maxIterations) {
        iterationsCapped = true;
        return { text, calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped };
      }

      const fnResponses = [];
      for (const call of fnCalls) {
        const callRecord = { name: call.name, args: call.args || {} };
        try {
          const toolResult = await executor(call.name, call.args || {});
          callRecord.result = toolResult;
          fnResponses.push({ functionResponse: { name: call.name, response: toolResult ?? {} } });
        } catch (err) {
          callRecord.error = err?.message || 'tool execution failed';
          fnResponses.push({ functionResponse: { name: call.name, response: { error: callRecord.error } } });
        }
        calls.push(callRecord);
      }

      result = await chat.sendMessage(fnResponses);
    }

    return { text: '', calls, usage: { input_tokens: usageIn, output_tokens: usageOut }, iterationsCapped: true };
  });
}

module.exports = { generateWithTools };
