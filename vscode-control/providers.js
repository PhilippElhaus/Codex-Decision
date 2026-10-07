"use strict";

const providers = Object.freeze({
  openai: { endpoint: "https://api.openai.com/v1/decisions", model: "gpt-6-luna", keyName: "OPENAI_API_KEY" },
  typesafe: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyName: "JEV_API_KEY" },
});

function provider(value = "openai") {
  if (!Object.hasOwn(providers, value)) throw new Error("Invalid decision provider");
  return providers[value];
}

function wireRequest(request) {
  if (request.model.startsWith("jev-")) return request;
  if (request.model !== "gpt-6-luna") throw new Error("Unsupported decision model");
  const questions = Object.entries(request.questions).sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, question]) => {
    if (question.type === "choice") return { name, type: "choice", instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })) };
    if (question.type !== "noul") throw new Error("Unsupported question");
    return { name, type: "predicate", instructions: question.instructions +
      (question.criteria ? `\nPredicate criteria: ${JSON.stringify(question.criteria)}` : "") };
  });
  return { model: request.model, input: JSON.stringify(request.state), questions };
}

function parseHealthResult(result, selected = "openai") {
  const spec = provider(selected);
  if (typeof result.model !== "string" || (selected === "openai" ? result.model !== spec.model : !result.model.startsWith("jev-")))
    throw new Error("Invalid decision health model");
  const answer = selected === "openai" ? result.answers?.[0] : result.answers?.ready;
  const probability = selected === "openai" ? answer?.probability : answer?.noul;
  if (selected === "openai" ? !Array.isArray(result.answers) || result.answers.length !== 1 ||
      answer?.name !== "ready" || answer?.type !== "predicate" : answer?.type !== "noul")
    throw new Error("Invalid decision health answer");
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error("Invalid decision health probability");
  return { ok: true, model: result.model };
}

module.exports = { providers, provider, wireRequest, parseHealthResult };
