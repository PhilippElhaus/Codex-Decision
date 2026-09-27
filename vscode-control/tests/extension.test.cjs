"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../core");

async function until(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for bridge state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("composer bridge selects integrations and reports view-scoped activity without a status item", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-control-test-"));
  const commands = new Map();
  let mode = "replace";
  let health = { ok: true, model: "jev-1.13.0" };
  let probes = 0;
  let suppliedKey;
  let configListener;
  let settingsPanel;
  let panelsCreated = 0;
  const fake = {
    window: {
      createStatusBarItem: () => { throw new Error("Status bar item must not be created"); },
      showInformationMessage: () => {},
      createWebviewPanel: () => {
        panelsCreated += 1;
        const messages = [];
        const webview = { cspSource: "vscode-resource:", asWebviewUri: () => "vscode-resource:/settings.js",
          postMessage: async (value) => { messages.push(value); },
          onDidReceiveMessage: (handler) => { webview.receive = handler; } };
        settingsPanel = { webview, messages, reveal() {} };
        return settingsPanel;
      },
    },
    Uri: { joinPath: () => ({}) }, ViewColumn: { Active: 1 }, ConfigurationTarget: { Global: 1 },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    workspace: {
      getConfiguration: () => ({ get: (key) => key === "dataDirectory" ? directory : key === "mode" ? mode : "",
        update: async (key, value) => { if (key === "mode") mode = value; } }),
      onDidChangeConfiguration: (callback) => { configListener = callback; return { dispose() {} }; },
    },
  };
  const originalLoad = Module._load;
  const originalHealth = core.checkHealth;
  core.checkHealth = async (_directory, _send, key) => { probes += 1; suppliedKey = key; return health; };
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fake;
    return originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[require.resolve("../extension")];
    extension = require("../extension");
  } finally {
    Module._load = originalLoad;
    core.checkHealth = originalHealth;
  }
  const context = { subscriptions: [], extensionUri: {} };
  try {
    extension.activate(context);
    assert.equal(commands.has("codexJev.selectHooks"), false);
    const bridge = commands.get("codexJev.bridge");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).enabled, false);
    const firstSelection = await bridge({ action: "setSelection", feature: "output", enabled: true, viewId: "view-one" });
    assert.equal(firstSelection.needsKey, true);
    assert.equal(panelsCreated, 0);
    const firstTest = await bridge({ action: "testApiKey", key: "example-test-key", viewId: "view-one" });
    assert.equal(firstTest.keyTest.ok, true);
    assert.equal(suppliedKey, "example-test-key");
    assert.equal(JSON.stringify(firstTest).includes("example-test-key"), false);
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).health?.ok === true);
    assert.equal((await core.readConfig(directory)).enabled, true);

    mode = "observe";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).mode === "observe");
    assert.equal((await core.readConfig(directory)).mode, "observe");
    mode = "replace";
    configListener({ affectsConfiguration: (key) => key === "codexJev" });
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).mode === "replace");

    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "calling", reason: "jev_request", tool: "Bash",
    }) + "\n" + JSON.stringify({
      status: "replace", reason: "jev_replace", tool: "Bash", original_chars: 11520,
      capsule_chars: 912, elapsed_ms: 480,
    }) + "\n");
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).stats.replaced === 1);
    const first = await bridge({ action: "status", viewId: "view-one" });
    assert.match(first.history[0], /replaced · Bash.*-92%/);
    assert.equal(first.stats.completed, 1);
    assert.equal(first.stats.savedChars, 10608);
    assert.equal(first.stats.estimatedTokensSaved, 2652);
    const beforeFailureProbe = probes;
    await fs.appendFile(path.join(directory, "events.jsonl"), JSON.stringify({
      status: "keep", reason: "evaluator_unavailable", tool: "Bash",
      original_chars: 20000, capsule_chars: 0, elapsed_ms: 120,
    }) + "\n");
    await until(async () => probes > beforeFailureProbe &&
      (await bridge({ action: "status", viewId: "view-one" })).stats.completed === 2);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health.ok, true);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).stats.estimatedTokensSaved, 2652);

    await Promise.all([
      bridge({ action: "setSelection", feature: "output", enabled: false, viewId: "view-one" }),
      bridge({ action: "setSelection", feature: "test_build", enabled: true, viewId: "view-one" }),
    ]);
    const selected = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(selected.outputEnabled, false);
    assert.equal(selected.testBuildEnabled, true);
    assert.equal(selected.stats.replaced, 1);
    const newView = await bridge({ action: "status", viewId: "view-two" });
    assert.equal(newView.stats.completed, 0);
    assert.equal(newView.stats.estimatedTokensSaved, 0);
    assert.deepEqual(newView.history, []);

    health = { ok: false, reason: "JEV_HTTP_ERROR" };
    await commands.get("codexJev.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "JEV_HTTP_ERROR");
    health = { ok: true, model: "jev-1.13.0" };
    assert.equal((await bridge({ action: "retryConnection", viewId: "view-two" })).health.ok, true);

    await bridge({ action: "openSettings", viewId: "view-two" });
    assert.equal(panelsCreated, 1);
    assert.match(settingsPanel.webview.html, /Jev settings/);
    await settingsPanel.webview.receive({ action: "ready" });
    const ready = settingsPanel.messages.at(-1);
    assert.equal(ready.action, "ready");
    assert.equal(ready.hasKey, false);
    assert.equal(ready.config.thresholds.output.routine_min, 90);
    assert.equal(JSON.stringify(ready).includes("JEV_API_KEY"), false);
    await settingsPanel.webview.receive({ action: "save", mode: "replace", key: "",
      thresholds: { output: { routine_min: 90 } } });
    assert.equal(settingsPanel.messages.at(-1).action, "error");
    assert.match(settingsPanel.messages.at(-1).message, /Enter an API key/);
    await settingsPanel.webview.receive({ action: "save", mode: "observe", key: "new-test-key-123",
      thresholds: { output: { routine_min: 97 } } });
    assert.equal(settingsPanel.messages.at(-1).action, "saved");
    assert.equal(await core.readApiKey(directory), "new-test-key-123");
    assert.equal((await core.readConfig(directory)).thresholds.output.routine_min, 97);
    assert.equal((await core.readConfig(directory)).mode, "observe");
    assert.equal(JSON.stringify(settingsPanel.messages).includes("new-test-key-123"), false);
    await settingsPanel.webview.receive({ action: "test", key: "" });
    assert.equal(suppliedKey, null);
    assert.equal(settingsPanel.messages.at(-1).result.ok, true);
    const saved = await bridge({ action: "saveApiKey", key: "another-test-key-123", viewId: "view-two" });
    assert.equal(saved.keySaved, true);
    assert.equal(saved.needsKey, false);
    assert.equal(await core.readApiKey(directory), "another-test-key-123");
    assert.equal(JSON.stringify(saved).includes("another-test-key-123"), false);
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
