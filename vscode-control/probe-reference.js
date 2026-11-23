"use strict";

// The former VS Code transport is retained for synthetic protocol comparisons.
const { wireRequest, parseHealthResult } = require("./providers");
const { certificateFetch } = require("./provider-transport");

async function boundedResponse(response, limit) {
  if (!response.body?.getReader) {
    // Small injected responses used by callers without a Fetch stream.
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("Decision response too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Decision response too large"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

async function probeReference(spec, selected, custom, key, send, signal, options) {
  const body = JSON.stringify(wireRequest({
    state: { output_sample: "Compiling module 1 done\nCompiling module 2 done" },
    model: spec.model,
    questions: { ready: { type: "noul", instructions: "Is output_sample routine build progress?" } },
  }, spec.protocol));
  const headers = { "Content-Type": "application/json" };
  if (spec.auth === "bearer") headers.Authorization = `Bearer ${key}`;
  else if (spec.auth === "basic") headers.Authorization = `Basic ${Buffer.from(`${spec.username}:${key}`, "utf8").toString("base64")}`;
  else if (spec.auth === "header") headers[spec.header_name] = key;
  let response;
  try {
    const transport = spec.ca_certificate && send === globalThis.fetch ?
      (url, init) => certificateFetch(url, init, spec.ca_certificate) : send;
    response = await transport(spec.endpoint, {
      method: "POST", headers,
      body, signal, redirect: "error",
    });
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, reason: "DECISION_CANCELLED" };
    return { ok: false, reason: ["AbortError", "TimeoutError"].includes(error?.name)
      ? "DECISION_TIMEOUT" : "DECISION_NETWORK_ERROR" };
  }
  if (!response || typeof response.ok !== "boolean") {
    return { ok: false, reason: "DECISION_INVALID_RESPONSE" };
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status) && typeof response.text === "function") {
      try {
        const error = JSON.parse(await boundedResponse(response, 4096));
        const details = [error.code, error.message, error.error?.code, error.error?.message];
        if (details.some((value) => typeof value === "string" && /expir/i.test(value))) {
          return { ok: false, reason: "DECISION_KEY_EXPIRED" };
        }
      } catch { /* An unstructured error keeps its HTTP status. */ }
    }
    return { ok: false, reason: `DECISION_HTTP_${response.status}` };
  }
  try {
    const output = await boundedResponse(response, 262144);
    return parseHealthResult(JSON.parse(output), selected, custom);
  } catch {
    return { ok: false, reason: options.signal?.aborted ? "DECISION_CANCELLED" :
      signal.aborted ? "DECISION_TIMEOUT" : "DECISION_INVALID_RESPONSE" };
  }
}

module.exports = { probeReference };
