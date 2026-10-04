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

test("composer bridge toggles Jev and reports view-scoped activity without a status item", async () => {
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
      () => bridge({ action: "status", viewId: "view-one", focused: false })));
    const defaultView = initialReplies[0];
    assert.ok(initialReplies.every((reply) => reply.enabled),
      "concurrent startup replies must not briefly report Jev off");
    assert.equal(defaultView.enabled, true);
    assert.equal(defaultView.needsKey, true);
    assert.equal(panel.dataDirectory(), scoped,
      "a restored thread is available to the panel before the composer receives focus");
    const panelMessages = [];
    panel.view = { visible: true, webview: { postMessage: async (message) => {
      panelMessages.push(message); return true;
    } } };
    await fs.mkdir(path.join(scoped, "logs"), { recursive: true });
    await fs.writeFile(path.join(scoped, "logs/latest-decision.json"), JSON.stringify({
      version: 4, id: "a".repeat(32), receipt_id: "b".repeat(32),
      at: new Date(Date.now() - 10_000).toISOString(), filter: "output", status: "keep",
      batch: { number: 1, count: 1, target_count: 1 }, batch_elapsed_ms: 12,
      rows: [{ line: 1, excerpt: "Synthetic build completed", action: "keep",
        reason: "task_relevant", task_relevant: .95 }],
      totals: { seen: 1, judged: 1, kept: 1, omitted: 0, protected: 0, unjudged: 0, requests: 2 },
    }));
    await bridge({ action: "status", focused: false });
    await panel.refresh();
    assert.equal(panelMessages.at(-1).decision.rows[0].excerpt, "Synthetic build completed");
    const refreshPanel = panel.refresh.bind(panel);
    let panelRefreshes = 0;
    panel.refresh = (...args) => { panelRefreshes += 1; return refreshPanel(...args); };
    await Promise.all(Array.from({ length: 12 }, () => bridge({ action: "status" })));
    assert.equal(panelRefreshes, 0,
      "unchanged composer status must not duplicate the panel's own polling");
    assert.equal((await bridge({ action: "openTypeSafe", viewId: "view-one" })).externalOpen, true);
    assert.equal(openedExternal, "https://typesafe.ai/");
    browserAvailable = false;
    assert.equal((await bridge({ action: "openTypeSafe", viewId: "view-one" })).externalOpen, false);
    browserAvailable = true;
    const firstSelection = await bridge({ action: "setSelection", enabled: true, viewId: "view-one" });
    assert.equal(firstSelection.needsKey, true);
    assert.equal(firstSelection.expectedHookVersion, require("../../vscode-control/package.json").codexJevHookVersion);
    const firstTest = await bridge({ action: "testApiKey", key: "example-test-key", viewId: "view-one" });
    assert.equal(firstTest.keyTest.ok, true);
    assert.equal(suppliedKey, "example-test-key");
    assert.equal(JSON.stringify(firstTest).includes("example-test-key"), false);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health?.reason, "JEV_KEY_MISSING");
    assert.equal((await core.readConfig(scoped)).enabled, true);
    assert.equal(firstSelection.classificationPulse, 0, "key probes do not signal classification");

    await fs.mkdir(path.join(scoped, "logs"), { recursive: true });
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
      status: "classifying", reason: "classification_start", requests: 0,
    }) + "\n");
    const started = await bridge({ action: "status" });
    assert.equal(started.classificationPulse, 1);
    assert.equal(started.stats.calls, 0, "start signals do not double count requests");
    assert.deepEqual(started.history, [], "classification has no line decision");
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
    assert.equal(first.classificationPulse, 1, "relevance completion does not pulse");
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
      status: "classifying", reason: "classification_start", requests: 0,
    }) + "\n" + JSON.stringify({
      status: "skip", reason: "choice_kept_full_output", tool: "Read", requests: 1,
      original_chars: 16000, capsule_chars: 16000, elapsed_ms: 80,
    }) + "\n");
    await until(async () => (await bridge({ action: "status", viewId: "view-one" })).stats.calls === 2);
    const gateSkip = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(gateSkip.stats.completed, 1);
    assert.equal(gateSkip.recent, first.recent, "classification preserves the latest line decision");
    assert.equal(gateSkip.classificationPulse, 2);
    assert.equal((await bridge({ action: "status" })).classificationPulse, 2,
      "repeated polls do not retrigger classification");
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
      bridge({ action: "setSelection", enabled: false, viewId: "view-one" }),
      bridge({ action: "setSelection", enabled: true, viewId: "view-one" }),
    ]);
    const selected = await bridge({ action: "status", viewId: "view-one" });
    assert.equal(selected.stats.replaced, 1);
    const beforeViewSwitch = panelRefreshes;
    const newView = await bridge({ action: "status", viewId: "view-two" });
    assert.equal(panelRefreshes, beforeViewSwitch + 1,
      "a newly focused composer refreshes the panel immediately");
    assert.equal(newView.stats.completed, 0);
    assert.equal(newView.stats.estimatedTokensSaved, 0);
    assert.deepEqual(newView.history, []);
    assert.equal(newView.classificationPulse, 0, "old start signals do not replay in a new view");
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
    await bridge({ action: "setSelection", enabled: true,
      viewId: "view-one" });
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).enabled, true,
      "views of the same thread share a saved selection");
    await bridge({ action: "setSelection", enabled: false,
      viewId: "view-one" });

    await commands.get("codexJev.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "JEV_KEY_MISSING");

    assert.equal(commands.has("codexJev.openSettings"), false);
    const ready = (await bridge({ action: "settingsRead" })).settings;
    assert.equal(ready.action, "ready");
    assert.equal(ready.hasKey, false);
    assert.equal(ready.keyLength, 0);
    assert.equal(ready.config.relevance_policy.relevant_max, 5);
    assert.deepEqual(ready.defaults, { mode: "replace", relevance_policy: core.DEFAULT_RELEVANCE_POLICY,
      log_limit_mb: 50, never_delete_logs: false });
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
    const withoutKey = (await bridge({ action: "settingsSave", mode: "replace", key: "", logLimitMb: 50, neverDeleteLogs: false,
      relevancePolicy: { relevant_max: 5 } })).settings;
    assert.equal(withoutKey.action, "saved", "global settings do not require a key or thread");
    assert.equal(withoutKey.hasKey, false);
    const relevancePolicy = { relevant_max: 3 };
    const savedSettings = (await bridge({ action: "settingsSave", mode: "observe", key: "new-test-key-123", logLimitMb: 9999, neverDeleteLogs: true,
      relevancePolicy })).settings;
    assert.equal(savedSettings.action, "saved");
    assert.equal(savedSettings.keyLength, "new-test-key-123".length);
    assert.equal(await core.readApiKey(directory), "new-test-key-123");
    assert.equal((await core.readConfig(scoped)).mode, "replace", "session selection remains separate");
    assert.equal((await core.readGlobalSettings(directory)).mode, "observe");
    assert.equal((await core.readGlobalSettings(directory)).log_limit_mb, 9999);
    assert.equal((await core.readGlobalSettings(directory)).never_delete_logs, true);
    assert.deepEqual((await core.readGlobalSettings(directory)).relevance_policy, relevancePolicy);
    assert.equal(JSON.stringify(savedSettings).includes("new-test-key-123"), false);
    const readyAfterSave = (await bridge({ action: "settingsRead" })).settings;
    assert.equal(readyAfterSave.hasKey, true);
    assert.equal(readyAfterSave.keyLength, "new-test-key-123".length);
    assert.deepEqual(readyAfterSave.config.relevance_policy, relevancePolicy);
    assert.equal(readyAfterSave.defaults.relevance_policy.relevant_max, 5);
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
      enabled: true });
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).enabled, true);
    assert.equal((await core.readConfig(scoped)).enabled, false);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).stats.replaced, 1,
      "another thread view cannot erase the first view's decisions");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).enabled, false,
      "another thread view cannot change the first view's filters");
    const returned = await bridge({ action: "status", viewId: "view-four" });
    assert.equal(returned.enabled, false);
    assert.equal(returned.stats.completed, 0, "old activity stays outside the new view");

    await fs.writeFile(path.join(scoped, "config.json"), '{"schema_version":1,"enabled":true}');
    const broken = await bridge({ action: "status", viewId: "view-five" });
    assert.equal(broken.configurationError, "Jev configuration could not be read");
    assert.equal(broken.health.reason, "JEV_CONFIG_ERROR");
    const missingView = await bridge({ action: "setSelection", viewId: "", enabled: true });
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
    assert.deepEqual(homeSettings.config.relevance_policy, relevancePolicy);
    const homeSaved = (await rawBridge({ action: "settingsSave", viewId: "home-view", sessionId: null,
      expectsLocalSession: false, mode: "replace", key: "", logLimitMb: 80,
      neverDeleteLogs: false,  relevancePolicy })).settings;
    assert.equal(homeSaved.action, "saved");
    assert.equal((await core.readGlobalSettings(directory)).log_limit_mb, 80);
    const homeSelection = await rawBridge({ action: "setSelection", viewId: "home-view", sessionId: null,
      expectsLocalSession: false, enabled: true });
    assert.equal(homeSelection.enabled, false);
    assert.equal((await core.readConfig(core.sessionDirectory(directory, "other-window"))).enabled, true);
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
