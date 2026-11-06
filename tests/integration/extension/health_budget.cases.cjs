"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { loadWithVscode, until } = require("../../support/vscode-loader.cjs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../../vscode-control/core");

test("settings and key saves supersede old probes and finish fallback health inside the UI reply deadline", { timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-health-budget-"));
  const commands = new Map();
  const context = { subscriptions: [], extensionUri: {} };
  const requests = [];
  let slowPrimary = true;
  let slowAll = false;
  let aborted = 0;
  const fake = {
    window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
    commands: {
      registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; },
      executeCommand: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: () => directory }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, { signal }) => {
    const provider = url.includes("openai.com") ? "openai" : "typesafe";
    requests.push(provider);
    if (slowAll || provider === "openai" && slowPrimary) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: false, status: 503 }), 12000);
        const cancel = () => { aborted += 1; clearTimeout(timer); reject(signal.reason); };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    }
    return { ok: true, text: async () => JSON.stringify(provider === "openai" ?
      { model: "gpt-6-luna", answers: [{ name: "ready", type: "predicate", probability: .9 }] } :
      { model: "jev-latest", answers: { ready: { type: "noul", noul: .9 } } }) };
  };
  loadWithVscode(require.resolve("../../../vscode-control/extension"), fake).activate(context);
  try {
    await core.writeApiKey(directory, "synthetic-health-openai", "openai");
    await core.writeApiKey(directory, "synthetic-health-typesafe", "typesafe");
    const bridge = commands.get("codexDecision.bridge");
    const route = { viewId: "budget-home", sessionId: null, focused: true };
    const save = (provider, fallbackEnabled) => bridge({ ...route, action: "settingsSave", provider,
      fallbackEnabled, key: "", mode: "replace", relevancePolicy: { relevant_max: 5 },
      logLimitMb: 50, neverDeleteLogs: false });
    await bridge({ ...route, action: "status" });
    await until(() => requests.length === 1);
    const changedAt = performance.now();
    const switched = await save("typesafe", false);
    assert.equal(switched.settings.action, "saved");
    assert.equal(switched.health.provider, "typesafe");
    assert.ok(performance.now() - changedAt < 1000, "provider save must cancel the old six-second check");
    assert.equal(aborted, 1);
    assert.deepEqual(requests, ["openai", "typesafe"], "switch runs one fresh check");
    slowPrimary = false;
    let before = requests.length;
    await save("typesafe", false);
    assert.deepEqual(requests.slice(before), ["typesafe"], "normal settings save does not duplicate a check");
    before = requests.length;
    const keySaved = await bridge({ ...route, action: "saveApiKey", provider: "typesafe", key: "" });
    assert.equal(keySaved.keySaved, true);
    assert.deepEqual(requests.slice(before), ["typesafe"], "normal saved-key selection runs one check");
    slowAll = true;
    before = requests.length;
    const started = performance.now();
    const failed = await save("openai", true);
    const elapsed = performance.now() - started;
    assert.equal(failed.settings.action, "saved");
    assert.equal(failed.health.reason, "DECISION_TIMEOUT");
    assert.equal(failed.health.provider, "typesafe");
    assert.equal(failed.needsKey, false);
    assert.deepEqual(requests.slice(before), ["openai", "typesafe"], "slow fallback checks each provider once");
    assert.ok(elapsed >= 5500 && elapsed < 8500, `combined health checks took ${elapsed} ms`);
    assert.equal(aborted, 3, "both slow provider checks stop at their budgets");
  } finally {
    for (const subscription of context.subscriptions.reverse()) subscription.dispose();
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true });
  }
});
