"use strict";

const providers = Object.freeze({
  openai: { endpoint: "https://api.openai.com/v1/decisions", model: "gpt-6-luna", keyName: "OPENAI_API_KEY", protocol: "openai", auth: "bearer" },
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyName: "JEV_API_KEY", protocol: "jev", auth: "bearer" },
});

function validateCustomProvider(value) {
  const fields = ["name", "protocol", "endpoint", "model", "auth", "username", "header_name"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)))
    throw new Error("Invalid custom provider");
  const result = { username: "", header_name: "", ...value };
  if (!["openai", "jev"].includes(result.protocol) || !["bearer", "basic", "header", "none"].includes(result.auth))
    throw new Error("Choose a custom provider schema and authentication method");
  if (typeof result.name !== "string" || !result.name.trim() || Buffer.byteLength(result.name) > 80 || /\p{Cc}/u.test(result.name) ||
      typeof result.model !== "string" || !/^[\x21-\x7e]{1,128}$/.test(result.model))
    throw new Error("Enter a provider name and model ID");
  if (typeof result.endpoint !== "string" || Buffer.byteLength(result.endpoint) > 2048 || !/^https?:\/\//.test(result.endpoint) || /[\p{Cc}\s\\?#]/u.test(result.endpoint))
    throw new Error("Enter a complete HTTPS endpoint URL");
  let endpoint;
  try { endpoint = new URL(result.endpoint); } catch { throw new Error("Enter a complete HTTPS endpoint URL"); }
  const authority = result.endpoint.slice(result.endpoint.indexOf("://") + 3).split("/", 1)[0];
  if (authority.includes("@") || endpoint.port === "0" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && /^(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority))))
    throw new Error("Use HTTPS, or HTTP on numeric loopback, without credentials, query, or fragment");
  if (typeof result.username !== "string" || Buffer.byteLength(result.username) > 256 || /[\p{Cc}:]/u.test(result.username) ||
      (result.auth === "basic" && !result.username)) throw new Error("Enter a Basic authentication username without a colon");
  const blocked = /^(?:authorization|proxy-authorization|content-type|content-length|host|connection|cookie|set-cookie|transfer-encoding|upgrade|accept-encoding|te|trailer|expect|user-agent)$/i;
  if (typeof result.header_name !== "string" || Buffer.byteLength(result.header_name) > 128 ||
      (result.auth === "header" && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(result.header_name) || blocked.test(result.header_name))))
    throw new Error("Enter an API key header such as X-API-Key");
  if (result.auth !== "basic") result.username = "";
  if (result.auth !== "header") result.header_name = "";
  return result;
}

function provider(value = "openai", custom) {
  if (value === "custom") return { ...validateCustomProvider(custom), keyName: custom.auth === "basic" ? "CUSTOM_PASSWORD" : "CUSTOM_API_KEY" };
  if (!Object.hasOwn(providers, value)) throw new Error("Invalid decision provider");
  return providers[value];
}

function wireRequest(request, protocol = request.model.startsWith("jev-") ? "jev" : "openai") {
  if (protocol === "jev") return request;
  if (protocol !== "openai") throw new Error("Unsupported decision schema");
  const questions = Object.entries(request.questions).sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, question]) => {
    if (question.type === "choice") return { name, type: "choice", instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })) };
    if (question.type !== "noul") throw new Error("Unsupported question");
    return { name, type: "predicate", instructions: question.instructions +
      (question.criteria ? `\nPredicate criteria: ${JSON.stringify(question.criteria)}` : "") };
  });
  return { model: request.model, input: JSON.stringify(request.state), questions };
}

function parseHealthResult(result, selected = "openai", custom) {
  const spec = provider(selected, custom);
  const openai = spec.protocol === "openai";
  if (typeof result.model !== "string" || (selected === "custom" || openai ? result.model !== spec.model : !result.model.startsWith("jev-")))
    throw new Error("Invalid decision health model");
  const answer = openai ? result.answers?.[0] : result.answers?.ready;
  const probability = openai ? answer?.probability : answer?.noul;
  if (openai ? !Array.isArray(result.answers) || result.answers.length !== 1 ||
      answer?.name !== "ready" || answer?.type !== "predicate" : answer?.type !== "noul")
    throw new Error("Invalid decision health answer");
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error("Invalid decision health probability");
  return { ok: true, model: result.model };
}

module.exports = { providers, provider, wireRequest, parseHealthResult, validateCustomProvider };
