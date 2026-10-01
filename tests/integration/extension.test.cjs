"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../vscode-control/core");

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
  let openedExternal;
  let executedCommand;
  let browserAvailable = true;
  let configListener;
  let panel;
  const fake = {
    window: {
      createStatusBarItem: () => { throw new Error("Status bar item must not be created"); },
      showInformationMessage: () => {},
      createWebviewPanel: () => { throw new Error("Jev settings must stay in Codex settings"); },
      registerWebviewViewProvider: (_id, provider) => { panel = provider; return { dispose() {} }; },
    },
    Uri: { joinPath: () => ({}), file: (filename) => ({ fsPath: filename }), parse: (uri) => ({ toString: () => uri }) }, ViewColumn: { Active: 1 }, ConfigurationTarget: { Global: 1 },
    env: { openExternal: async (uri) => { openedExternal = uri.fsPath || uri.toString(); return browserAvailable; } },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; },
      async executeCommand(command) { executedCommand = command; },
    },
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
    delete require.cache[require.resolve("../../vscode-control/extension")];
    extension = require("../../vscode-control/extension");
  } finally {
    Module._load = originalLoad;
    core.checkHealth = originalHealth;
  }
  const context = { subscriptions: [], extensionUri: {} };
  try {
    extension.activate(context);
    await commands.get("codexJev.showLatestDecision")();
    assert.equal(executedCommand, "codexJevDecision.focus");
    assert.equal(commands.has("codexJev.selectHooks"), false);
    const rawBridge = commands.get("codexJev.bridge");
    const sessionId = "fixture-session";
    const scoped = core.sessionDirectory(directory, sessionId);
    const bridge = (request) => rawBridge({ sessionId, viewId: "view-one", focused: true, ...request });
    const initialReplies = await Promise.all(Array.from({ length: 12 },
      () => bridge({ action: "status", viewId: "view-one" })));
    const defaultView = initialReplies[0];
    assert.ok(initialReplies.every((reply) => reply.enabled && reply.outputEnabled),
      "concurrent startup replies must not briefly report Jev off");
    assert.equal(defaultView.enabled, true);
    assert.equal(defaultView.outputEnabled, true);
    assert.equal(defaultView.testBuildEnabled, true);
    assert.equal(defaultView.searchListingEnabled, true);
    assert.equal(defaultView.needsKey, true);
    assert.equal((await bridge({ action: "openTypeSafe", viewId: "view-one" })).externalOpen, true);
    assert.equal(openedExternal, "https://typesafe.ai/");
    browserAvailable = false;
    assert.equal((await bridge({ action: "openTypeSafe", viewId: "view-one" })).externalOpen, false);
    browserAvailable = true;
    const firstSelection = await bridge({ action: "setSelection", feature: "output", enabled: true, viewId: "view-one" });
    assert.equal(firstSelection.needsKey, true);
    assert.equal(firstSelection.expectedHookVersion, require("../../vscode-control/package.json").codexJevHookVersion);
    const firstTest = await bridge({ action: "testApiKey", key: "example-test-key", viewId: "view-one" });
    assert.equal(firstTest.keyTest.ok, true);
    assert.equal(suppliedKey, "example-test-key");
    assert.equal(JSON.stringify(firstTest).includes("example-test-key"), false);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health?.reason, "JEV_KEY_MISSING");
    assert.equal((await core.readConfig(scoped)).enabled, true);

    await fs.mkdir(path.join(scoped, "logs"), { recursive: true });
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
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
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
      status: "skip", reason: "choice_kept_full_output", tool: "Read", requests: 1,
      original_chars: 16000, capsule_chars: 16000, elapsed_ms: 80,
    }) + "\n");
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).stats.calls === 2);
    const gateSkip = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(gateSkip.stats.completed, 1);
    assert.match(gateSkip.recent, /choice_kept_full_output/);
    const beforeFailureProbe = probes;
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
      status: "keep", reason: "evaluator_unavailable", tool: "Bash",
      original_chars: 20000, capsule_chars: 0, elapsed_ms: 120,
    }) + "\n");
    await until(async () =>
      (await bridge({ action: "status", viewId: "view-one" })).stats.completed === 2);
    assert.equal(probes, beforeFailureProbe, "missing key does not trigger a network probe");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health.reason, "JEV_KEY_MISSING");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).stats.estimatedTokensSaved, 2652);

    await Promise.all([
      bridge({ action: "setSelection", feature: "output", enabled: false, viewId: "view-one" }),
      bridge({ action: "setSelection", feature: "test_build", enabled: true, viewId: "view-one" }),
      bridge({ action: "setSelection", feature: "search_listing", enabled: false, viewId: "view-one" }),
    ]);
    const selected = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(selected.outputEnabled, false);
    assert.equal(selected.testBuildEnabled, true);
    assert.equal(selected.stats.replaced, 1);
    const newView = await bridge({ action: "status", viewId: "view-two" });
    assert.equal(newView.stats.completed, 0);
    assert.equal(newView.stats.estimatedTokensSaved, 0);
    assert.deepEqual(newView.history, []);
    assert.equal(panel.dataDirectory(), scoped);
    for (let index = 0; index < 8; index += 1) {
      const [homeStatus, threadStatus] = await Promise.all([
        rawBridge({ action: "status", viewId: "background-home", sessionId: null,
          expectsLocalSession: false }),
        bridge({ action: "status", viewId: "view-one" }),
      ]);
      assert.equal(panel.dataDirectory(), scoped, "background status cannot switch the panel");
      assert.equal(homeStatus.enabled, false, "background home view stays neutral");
      assert.equal(threadStatus.enabled, true, "background view cannot turn off the thread");
      assert.equal(threadStatus.stats.replaced, 1, "background view cannot erase thread activity");
    }
    await bridge({ action: "setSelection", feature: "search_listing", enabled: true,
      viewId: "view-one" });
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).searchListingEnabled, true,
      "views of the same thread share a saved selection");
    await bridge({ action: "setSelection", feature: "search_listing", enabled: false,
      viewId: "view-one" });

    await commands.get("codexJev.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "JEV_KEY_MISSING");

    assert.equal(commands.has("codexJev.openSettings"), false);
    const ready = (await bridge({ action: "settingsRead" })).settings;
    assert.equal(ready.action, "ready");
    assert.equal(ready.hasKey, false);
    assert.equal(ready.keyLength, 0);
    assert.equal(ready.config.line_policy.output.omit_min, 95);
    assert.deepEqual(ready.defaults, { mode: "replace", line_policy: core.DEFAULT_LINE_POLICY,
      search_relevance: core.DEFAULT_SEARCH_RELEVANCE,
      choice_gate_enabled: true, log_limit_mb: 50, never_delete_logs: false });
    assert.equal(ready.config.choice_gate_enabled, true);
    assert.equal(ready.config.log_limit_mb, 50);
    assert.equal(ready.lifetime.calls, 2);
    assert.equal(ready.lifetime.replaced, 1);
    assert.equal(ready.lifetime.estimatedTokensSaved, 2652);
    assert.equal(JSON.stringify(ready).includes("JEV_API_KEY"), false);
    const retained = (await bridge({ action: "settingsSetNeverDeleteLogs", neverDeleteLogs: true })).settings;
    assert.deepEqual(retained, { action: "neverDeleteLogsSaved", neverDeleteLogs: true });
    assert.equal((await bridge({ action: "settingsRead" })).settings.config.never_delete_logs, true);
    assert.equal((await core.readConfig(scoped)).mode, "replace");
    const invalidRetention = (await bridge({ action: "settingsSetNeverDeleteLogs", neverDeleteLogs: "true" })).settings;
    assert.equal(invalidRetention.action, "error");
    assert.equal((await core.readGlobalSettings(directory)).never_delete_logs, true);
    assert.equal((await bridge({ action: "settingsSetNeverDeleteLogs", neverDeleteLogs: false })).settings.action,
      "neverDeleteLogsSaved");
    assert.equal((await bridge({ action: "settingsOpenLogs" })).settings.action, "openedLogs");
    assert.equal(openedExternal, directory);
    const withoutKey = (await bridge({ action: "settingsSave", mode: "replace", key: "", logLimitMb: 50, neverDeleteLogs: false, choiceGateEnabled: true,
      linePolicy: { output: { omit_min: 95 } } })).settings;
    assert.equal(withoutKey.action, "saved", "global settings do not require a key or thread");
    assert.equal(withoutKey.hasKey, false);
    const linePolicy = { output: { omit_min: 97, exact_max: 3 },
      test_build: { omit_min: 95, exact_max: 5 }, search_listing: { omit_min: 95, exact_max: 5 } };
    const savedSettings = (await bridge({ action: "settingsSave", mode: "observe", key: "new-test-key-123", logLimitMb: 9999, neverDeleteLogs: true, choiceGateEnabled: false,
      linePolicy })).settings;
    assert.equal(savedSettings.action, "saved");
    assert.equal(savedSettings.keyLength, "new-test-key-123".length);
    assert.equal(await core.readApiKey(directory), "new-test-key-123");
    assert.equal((await core.readConfig(scoped)).mode, "replace", "session selection remains separate");
    assert.equal((await core.readGlobalSettings(directory)).mode, "observe");
    assert.equal((await core.readGlobalSettings(directory)).log_limit_mb, 9999);
    assert.equal((await core.readGlobalSettings(directory)).never_delete_logs, true);
    assert.equal((await core.readGlobalSettings(directory)).choice_gate_enabled, false);
    assert.deepEqual((await core.readGlobalSettings(directory)).line_policy, linePolicy);
    assert.equal(JSON.stringify(savedSettings).includes("new-test-key-123"), false);
    const readyAfterSave = (await bridge({ action: "settingsRead" })).settings;
    assert.equal(readyAfterSave.hasKey, true);
    assert.equal(readyAfterSave.keyLength, "new-test-key-123".length);
    assert.deepEqual(readyAfterSave.config.line_policy, linePolicy);
    assert.equal(readyAfterSave.defaults.line_policy.output.omit_min, 95);
    assert.equal(JSON.stringify(readyAfterSave).includes("new-test-key-123"), false);
    const tested = (await bridge({ action: "settingsTest", key: "" })).settings;
    assert.equal(suppliedKey, null);
    assert.equal(tested.result.ok, true);
    const saved = await bridge({ action: "saveApiKey", key: "another-test-key-123", viewId: "view-two" });
    assert.equal(saved.keySaved, true);
    assert.equal(saved.needsKey, false);
    assert.equal(await core.readApiKey(directory), "another-test-key-123");
    assert.equal(JSON.stringify(saved).includes("another-test-key-123"), false);
    health = { ok: false, reason: "JEV_HTTP_ERROR" };
    await commands.get("codexJev.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "JEV_HTTP_ERROR");
    health = { ok: true, model: "jev-1.13.0" };
    assert.equal((await bridge({ action: "retryConnection", viewId: "view-two" })).health.ok, true);

    const other = await bridge({ action: "status", sessionId: "other-window", viewId: "view-three" });
    assert.equal(other.enabled, true);
    assert.equal(other.stats.completed, 0);
    assert.deepEqual(other.history, []);
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).enabled, true);
    await bridge({ action: "setSelection", sessionId: "other-window", viewId: "view-three",
      feature: "search_listing", enabled: true });
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).search_listing_enabled, true);
    assert.equal((await core.readConfig(scoped)).search_listing_enabled, false);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).stats.replaced, 1,
      "another thread view cannot erase the first view's decisions");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).searchListingEnabled, false,
      "another thread view cannot change the first view's filters");
    const returned = await bridge({ action: "status", viewId: "view-four" });
    assert.equal(returned.outputEnabled, false);
    assert.equal(returned.testBuildEnabled, true);
    assert.equal(returned.searchListingEnabled, false);
    assert.equal(returned.stats.completed, 0, "old activity stays outside the new view");

    await fs.writeFile(path.join(scoped, "config.json"), '{"schema_version":1,"enabled":true}');
    const broken = await bridge({ action: "status", viewId: "view-five" });
    assert.equal(broken.configurationError, "Jev configuration could not be read");
    assert.equal(broken.health.reason, "JEV_CONFIG_ERROR");
    const missingView = await bridge({ action: "setSelection", viewId: "", feature: "output", enabled: true });
    assert.equal(missingView.configurationError, "Codex session could not be identified");
    assert.equal(missingView.enabled, false);
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).enabled, true);
    const home = await rawBridge({ action: "status", viewId: "home-view", sessionId: null,
      expectsLocalSession: false });
    assert.equal(home.configurationError, null);
    assert.equal(home.sessionPending, true);
    assert.equal(home.panelFault, null);
    await until(async () => (await rawBridge({ action: "status", viewId: "home-view",
      sessionId: null, expectsLocalSession: false })).health?.ok === true);
    const homeProbeCount = probes;
    for (let index = 0; index < 3; index += 1) {
      const status = await rawBridge({ action: "status", viewId: "home-view", sessionId: null,
        expectsLocalSession: false });
      assert.equal(status.health.ok, true);
    }
    assert.equal(probes, homeProbeCount, "home status polls reuse the API check");
    const homeSettings = (await rawBridge({ action: "settingsRead", viewId: "home-view",
      sessionId: null, expectsLocalSession: false })).settings;
    assert.equal(homeSettings.action, "ready");
    assert.equal(homeSettings.config.mode, "observe");
    assert.deepEqual(homeSettings.config.line_policy, linePolicy);
    const homeSaved = (await rawBridge({ action: "settingsSave", viewId: "home-view", sessionId: null,
      expectsLocalSession: false, mode: "replace", key: "", logLimitMb: 80,
      neverDeleteLogs: false, choiceGateEnabled: true, linePolicy })).settings;
    assert.equal(homeSaved.action, "saved");
    assert.equal((await core.readGlobalSettings(directory)).log_limit_mb, 80);
    const homeSelection = await rawBridge({ action: "setSelection", viewId: "home-view", sessionId: null,
      expectsLocalSession: false, feature: "output", enabled: true });
    assert.equal(homeSelection.enabled, false);
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).search_listing_enabled, true);
    const unknownLocal = await rawBridge({ action: "status", viewId: "local-view", sessionId: null,
      expectsLocalSession: true });
    assert.equal(unknownLocal.configurationError, "Codex session could not be identified");
    assert.equal(unknownLocal.sessionPending, false);
    const recovered = await bridge({ action: "status", viewId: "restored-view" });
    assert.equal(recovered.configurationError, "Jev configuration could not be read");
    assert.equal(recovered.sessionPending, false);
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
