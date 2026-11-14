"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { loadWithVscode } = require("../../support/vscode-loader.cjs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../../vscode-control/core");

test("automatic repair and assistance honor the same environment and editor data-directory overrides", async () => {
  const environment = process.env.CODEX_DECISION_DATA_DIRECTORY;
  const selected = path.join(os.tmpdir(), "decision-environment-fixture");
  let configured = "", integration, assistance;
  const installed = [];
  const replacements = {
    "../../../vscode-control/integrated-install": { ensureIntegratedInstall: async (_vscode, _context, options) => {
      installed.push(options.dataDirectory()); return { status: "ready" };
    } },
    "../../../vscode-control/integration": { activateIntegration: (_vscode, _context, options) => { integration = options; } },
    "../../../vscode-control/assistance": { activateAssistance: (_vscode, _context, options) => { assistance = options; } },
  };
  const previous = [];
  const context = { subscriptions: [], extensionUri: {} };
  const fake = {
    window: { registerWebviewViewProvider: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: () => configured }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  };
  try {
    process.env.CODEX_DECISION_DATA_DIRECTORY = selected;
    for (const [name, exports] of Object.entries(replacements)) {
      const filename = require.resolve(name);
      require(filename);
      previous.push([filename, require.cache[filename].exports]);
      require.cache[filename].exports = exports;
    }
    loadWithVscode(require.resolve("../../../vscode-control/extension"), fake).activate(context);
    assert.equal(integration.dataDirectory(), selected);
    assert.equal(assistance.dataDirectory(), selected);
    await integration.ready(); await assistance.ready();
    assert.deepEqual(installed, [selected, selected]);
    configured = path.join(os.tmpdir(), "decision-editor-fixture");
    assert.equal(integration.dataDirectory(), configured);
    assert.equal(assistance.dataDirectory(), configured);
    await integration.ready(); await assistance.ready();
    assert.deepEqual(installed.slice(2), [configured, configured]);
  } finally {
    for (const [filename, exports] of previous) require.cache[filename].exports = exports;
    if (environment === undefined) delete process.env.CODEX_DECISION_DATA_DIRECTORY;
    else process.env.CODEX_DECISION_DATA_DIRECTORY = environment;
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
  }
});

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
