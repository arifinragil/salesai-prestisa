function getThreshold() {
  const v = parseFloat(process.env.AI_CONFIDENCE_THRESHOLD);
  return Number.isFinite(v) ? v : 0.7;
}

/**
 * Score reply quality on [0..1]. Heuristic blend.
 *
 * Components:
 *   +0.3 reply non-empty and reasonable length (10-800 chars)
 *   +0.2 tool calls succeeded (no errors) OR no tools needed
 *   +0.2 intent matched (not 'unknown' / 'other')
 *   +0.2 not iterationsCapped
 *   +0.1 reply contains a CTA-ish phrase ("kirim link", "tinggal", "yuk", "?")
 *
 * Penalties:
 *   -0.4 if reply is empty
 *   -0.3 if all tool calls errored
 */
function scoreReply({ reply, toolCalls, intent, iterationsCapped }) {
  let s = 0;

  const len = (reply || '').trim().length;
  if (len === 0) {
    s -= 0.4;
  } else if (len >= 10 && len <= 800) {
    s += 0.3;
  } else if (len > 800) {
    s += 0.15;
  } else {
    s += 0.05;
  }

  const calls = toolCalls || [];
  if (calls.length === 0) {
    s += 0.2;
  } else {
    const errored = calls.filter((c) => c.error).length;
    if (errored === calls.length) s -= 0.3;
    else if (errored === 0) s += 0.2;
    else s += 0.1;
  }

  if (intent && intent !== 'unknown' && intent !== 'other') s += 0.2;

  if (!iterationsCapped) s += 0.2;

  if (reply && /(\bkirim link\b|\btinggal\b|\byuk\b|\?)/i.test(reply)) s += 0.1;

  return Math.max(0, Math.min(1, s));
}

function shouldEscalate(score) {
  return score < getThreshold();
}

module.exports = { scoreReply, shouldEscalate, getThreshold };
