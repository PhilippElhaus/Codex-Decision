"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { loadWithVscode } = require("../../support/vscode-loader.cjs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../../vscode-control/core");

test("settings save replies reflect the persisted provider, model, and mode in threads and on home", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-settings-response-"));
  const commands = new Map();
  const context = { subscriptions: [], extensionUri: {} };
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
  core.checkHealth = async (_directory, _send, _key, provider) => ({ ok: true, provider,
    model: provider === "typesafe" ? "jev-latest" : "gpt-6-luna" });
  try {
    loadWithVscode(require.resolve("../../../vscode-control/extension"), fake).activate(context);
  } finally {
    core.checkHealth = originalHealth;
  }
  try {
    const bridge = commands.get("codexDecision.bridge");
    for (const sessionId of ["settings-response-thread", null]) {
      const route = { viewId: sessionId ? "settings-thread" : "settings-home", sessionId,
        expectsLocalSession: sessionId !== null, sourceId: "settings-response-source", visible: true, focused: true };
      await bridge({ ...route, action: "status" });
      for (const [provider, model, mode] of [["typesafe", "jev-latest", "observe"], ["openai", "gpt-6-luna", "replace"]]) {
        const reply = await bridge({ ...route, action: "settingsSave", provider, mode, key: "",
          relevancePolicy: { relevant_max: 5 }, logLimitMb: 50, neverDeleteLogs: false });
        assert.equal(reply.settings.action, "saved");
        assert.deepEqual({ provider: reply.provider, model: reply.model, mode: reply.mode }, { provider, model, mode });
        const stored = await core.readGlobalSettings(directory);
        assert.deepEqual({ provider: stored.provider, model: stored.model, mode: stored.mode }, { provider, model, mode });
        const read = await bridge({ ...route, action: "settingsRead" });
        assert.deepEqual({ provider: read.provider, model: read.model, mode: read.mode }, { provider, model, mode });
      }
    }
  } finally {
    for (const subscription of context.subscriptions.reverse()) subscription.dispose();
    await fs.rm(directory, { recursive: true });
  }
});
