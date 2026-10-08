"use strict";

const MESSAGES = Object.freeze({
  budget: "Live evaluation budget exhausted; no provider request started.",
  transport: "Live provider transport failed.",
  response_size: "Live provider response exceeded the test limit.",
  credential_echo: "Live provider response echoed a credential; no response was saved.",
  usage: "Live provider usage is unavailable; no further request started.",
  invalid_usage: "Live provider usage failed validation.",
});

class LiveProxyError extends Error {
  constructor(code) { super(MESSAGES[code]); this.code = code; }
}

async function postLive({ endpoint, key, wire, calls, tokens, maxCalls, maxTokens,
  unknownUsage = false, onForward = () => {}, onResponse = () => {}, fetchImpl = fetch }) {
  if (unknownUsage) throw new LiveProxyError("usage");
  if (calls > maxCalls || tokens >= maxTokens) throw new LiveProxyError("budget");
  onForward();
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(wire), signal: AbortSignal.timeout(10000) });
  } catch { throw new LiveProxyError("transport"); }
  onResponse();
  const reader = response.body?.getReader();
  if (!reader) return { response, text: "" };
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) throw new LiveProxyError("response_size");
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks, size).toString("utf8");
    if (credentialEcho(text, key)) throw new LiveProxyError("credential_echo");
    return { response, text };
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error instanceof LiveProxyError ? error : new LiveProxyError("transport");
  } finally { reader.releaseLock(); }
}

function credentialEcho(text, key) {
  if (text.includes(key)) return true;
  // Inspect every string token, including duplicates that whole-body JSON
  // parsing could discard. The already bounded body bounds this scan too.
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
    try { if (JSON.parse(token[0]).includes(key)) return true; } catch {}
  }
  return false;
}

function observedUsage(body) {
  if (body?.usage === undefined) return { input: 0, output: 0, complete: false };
  const usage = body.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) ||
      ["input_tokens", "output_tokens"].some((key) => usage[key] !== undefined &&
        (!Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > 100_000_000))) {
    throw new LiveProxyError("invalid_usage");
  }
  return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
    complete: usage.input_tokens !== undefined && usage.output_tokens !== undefined };
}

module.exports = { LiveProxyError, postLive, observedUsage };
