"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { loadWithVscode } = require("../../support/vscode-loader.cjs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../../vscode-control/core");

test("saved provider switching retains credentials and fallback health requires explicit consent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-provider-controls-"));
  const commands = new Map();
  const context = { subscriptions: [], extensionUri: {} };
  const probes = [];
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
  const originalHealth = core.checkHealth;
  let primaryFails = false;
  let alternateFails = false;
  core.checkHealth = async (folder, _send, supplied, provider) => {
    probes.push({ provider, supplied });
    try { if (!supplied) await core.readApiKey(folder, provider); }
    catch (error) { return { ok: false, reason: error.decisionReason }; }
    if (provider === "typesafe" && alternateFails) return { ok: false, reason: "DECISION_NETWORK_ERROR" };
    return provider === "openai" && primaryFails ? { ok: false, reason: "DECISION_HTTP_429" } :
      { ok: true, model: provider === "openai" ? "gpt-6-luna" : "jev-latest" };
  };
  try {
    loadWithVscode(require.resolve("../../../vscode-control/extension"), fake).activate(context);
  } finally {
    core.checkHealth = originalHealth;
  }
  try {
    const bridge = commands.get("codexDecision.bridge");
    const route = { viewId: "provider-one", sessionId: "provider-session", focused: true };
    const other = { viewId: "provider-two", sessionId: "provider-session" };
    await core.writeApiKey(directory, "synthetic-jevv-key", "typesafe");
    const scoped = core.sessionDirectory(directory, route.sessionId);
    const sessionConfig = await core.ensureSessionDefaults(scoped);
    await fs.writeFile(path.join(scoped, "config.json"), JSON.stringify({ ...sessionConfig, fallback_enabled: true }));
    const inherited = await bridge({ ...route, action: "retryConnection" });
    assert.equal(inherited.fallbackEnabled, true, "session config consent is honored before global settings exist");
    assert.equal(inherited.health.provider, "typesafe");
    await bridge({ ...other, action: "status" });
    const save = (provider, fallbackEnabled, key = "") => bridge({ ...route, action: "settingsSave",
      provider, fallbackEnabled, key, mode: "replace", relevancePolicy: { relevant_max: 5 },
      logLimitMb: 50, neverDeleteLogs: false });
    let saved = await save("openai", false);
    assert.equal(saved.needsKey, true);
    assert.equal(saved.settings.hasKey, false);
    assert.deepEqual(saved.providerKeys, { openai: { hasKey: false }, typesafe: { hasKey: true } });
    const previousProbes = probes.length;
    await bridge({ ...route, action: "retryConnection" });
    assert.ok(probes.slice(previousProbes).every(probe => probe.provider === "openai"),
      "no alternate connection request without consent");
    saved = await save("openai", true);
    assert.equal(saved.provider, "openai", "configured primary stays selected");
    assert.equal(saved.health.provider, "typesafe");
    assert.equal(saved.health.fallback, true);
    assert.equal(saved.needsKey, false);
    const synchronized = await bridge({ ...other, action: "status" });
    assert.equal(synchronized.provider, "openai");
    assert.equal(synchronized.fallbackEnabled, true);
    assert.equal(synchronized.needsKey, false);
    alternateFails = true;
    const unavailableFallback = await bridge({ ...route, action: "retryConnection" });
    assert.equal(unavailableFallback.needsKey, false, "saved fallback connection failures do not request key reentry");
    assert.equal(unavailableFallback.health.provider, "typesafe");
    assert.equal(unavailableFallback.health.reason, "DECISION_NETWORK_ERROR");
    alternateFails = false;
    saved = await bridge({ ...route, action: "saveApiKey", provider: "typesafe", key: "" });
    assert.equal(saved.keySaved, true, "connect dialog can activate a stored key");
    assert.equal(saved.provider, "typesafe");
    assert.equal(await core.readApiKey(directory, "typesafe"), "synthetic-jevv-key");
    assert.equal((await bridge({ ...route, action: "testApiKey", provider: "typesafe", key: "" })).keyTest.ok, true);
    assert.equal(probes.at(-1).supplied, null, "blank test reads the selected saved key");
    saved = await save("openai", false, "synthetic-openai-key");
    assert.equal(saved.health.provider, "openai");
    assert.equal(saved.settings.providerKeys.typesafe.hasKey, true);
    assert.equal((await bridge({ ...other, action: "status" })).provider, "openai");
    primaryFails = true;
    saved = await save("openai", true);
    assert.equal(saved.health.provider, "typesafe");
    assert.equal(saved.health.primaryReason, "DECISION_HTTP_429");
    saved = await save("typesafe", false);
    assert.equal(saved.provider, "typesafe");
    assert.equal(saved.health.provider, "typesafe");
    assert.equal(await core.readApiKey(directory, "openai"), "synthetic-openai-key");
    assert.equal(await core.readApiKey(directory, "typesafe"), "synthetic-jevv-key");
    await bridge({ ...route, action: "retryConnection" });
    await bridge({ ...other, action: "retryConnection" });
    const beforeInvalid = probes.length;
    await fs.appendFile(path.join(directory, ".env"), "OPENAI_API_KEY=duplicate-openai-key\n");
    const invalidPrimary = await save("openai", true);
    assert.equal(invalidPrimary.health.reason, "DECISION_KEY_INVALID");
    assert.ok(probes.slice(beforeInvalid).every(probe => probe.provider === "openai"),
      "malformed primary credentials cannot trigger fallback");
    await save("typesafe", false);
    const ready = (await bridge({ ...route, action: "settingsRead" })).settings;
    assert.equal(ready.config.fallback_enabled, false);
    assert.deepEqual(ready.providerKeys, { openai: { hasKey: false }, typesafe: { hasKey: true } });
    assert.equal(JSON.stringify(ready).includes("synthetic-"), false);
    const invalid = await save("openai", "yes");
    assert.equal(invalid.settings.action, "error");
    assert.equal((await core.readGlobalSettings(directory)).provider, "typesafe");
  } finally {
    for (const subscription of context.subscriptions.reverse()) subscription.dispose();
    await fs.rm(directory, { recursive: true });
  }
});
