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
  const originalLoad = Module._load;
  const originalHealth = core.checkHealth;
  core.checkHealth = async (_directory, _send, _key, provider) => ({ ok: true, provider,
    model: provider === "typesafe" ? "jev-latest" : "gpt-6-luna" });
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? fake : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../../vscode-control/extension")];
    require("../../vscode-control/extension").activate(context);
  } finally {
    Module._load = originalLoad;
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

test("composer bridge toggles Decision and restores thread activity without a status item", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-control-test-"));
  const commands = new Map();
  let mode = "replace";
  let health = { ok: true, model: "jev-1.13.0" };
  let probes = 0;
  let historyReads = 0;
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
      createWebviewPanel: () => { throw new Error("Decision settings must stay in Codex settings"); },
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
  const originalRecentOutcomes = core.readRecentOutcomes;
  core.checkHealth = async (_directory, _send, key) => { probes += 1; suppliedKey = key; return health; };
  core.readRecentOutcomes = async (...args) => { historyReads += 1; return originalRecentOutcomes(...args); };
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
    core.readRecentOutcomes = originalRecentOutcomes;
  }
  const context = { subscriptions: [], extensionUri: {} };
  try {
    extension.activate(context);
    await commands.get("codexDecision.showLatestDecision")();
    assert.equal(executedCommand, "codexDecisionDecision.focus");
    assert.equal(commands.has("codexDecision.selectHooks"), false);
    const rawBridge = commands.get("codexDecision.bridge");
    const sessionId = "fixture-session";
    const scoped = core.sessionDirectory(directory, sessionId);
    const bridge = (request) => rawBridge({ sessionId, viewId: "view-one", sourceId: "main-source", visible: true, focused: true, ...request });
    const statusAfterMetadataMutation = async (request) => {
      // A timer poll may already have captured the previous file bytes. Drain
      // that flight, then assert a status read begun after the mutation.
      await bridge({ action: "status", ...request });
      return bridge({ action: "status", ...request });
    };
    await rawBridge({ action: "status", viewId: "startup-home", sourceId: "main-source",
      sessionId: null, visible: true, focused: true, expectsLocalSession: false });
    const initialReplies = await Promise.all(Array.from({ length: 12 },
      () => bridge({ action: "status", viewId: "view-one", focused: false })));
    const defaultView = initialReplies[0];
    assert.ok(initialReplies.every((reply) => reply.enabled),
      "concurrent startup replies must not briefly report Decision off");
    assert.equal(defaultView.enabled, true);
    assert.equal(defaultView.needsKey, true);
    assert.equal(panel.dataDirectory(), scoped,
      "a restored thread replaces the startup home route while focus remains in the terminal");
    await rawBridge({ action: "status", viewId: "hidden-thread", sourceId: "background-source",
      sessionId: "background-thread", visible: false, focused: false });
    assert.equal(panel.dataDirectory(), scoped, "a hidden thread cannot take over the selected thread");
    await rawBridge({ action: "status", viewId: "visible-background-thread", sourceId: "background-source",
      sessionId: "background-thread", visible: true, focused: false });
    assert.equal(panel.dataDirectory(), scoped, "an unfocused background webview cannot take over the selected thread");
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
    assert.equal((await bridge({ action: "openProvider", viewId: "view-one" })).externalOpen, true);
    assert.equal(openedExternal, "https://platform.openai.com/api-keys");
    browserAvailable = false;
    assert.equal((await bridge({ action: "openProvider", viewId: "view-one" })).externalOpen, false);
    browserAvailable = true;
    const firstSelection = await bridge({ action: "setSelection", enabled: true, viewId: "view-one" });
    assert.equal(firstSelection.needsKey, true);
    assert.equal(firstSelection.expectedHookVersion, require("../../vscode-control/package.json").codexDecisionHookVersion);
    const firstTest = await bridge({ action: "testApiKey", key: "example-test-key", viewId: "view-one" });
    assert.equal(firstTest.keyTest.ok, true);
    assert.equal(suppliedKey, "example-test-key");
    assert.equal(JSON.stringify(firstTest).includes("example-test-key"), false);
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health?.reason, "DECISION_KEY_MISSING");
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
    const readsAfterOutcome = historyReads;
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
    assert.equal(historyReads, readsAfterOutcome,
      "unchanged history is cached during status polls and classification-only events");
    const beforeFailureProbe = probes;
    await fs.appendFile(path.join(scoped, "logs", "events.jsonl"), JSON.stringify({
      status: "keep", reason: "evaluator_unavailable", tool: "Bash",
      original_chars: 20000, capsule_chars: 0, elapsed_ms: 120,
    }) + "\n");
    await until(async () =>
      (await bridge({ action: "status", viewId: "view-one" })).stats.completed === 2);
    assert.equal(probes, beforeFailureProbe, "missing key does not trigger a network probe");
    assert.equal((await bridge({ action: "status", viewId: "view-one" })).health.reason, "DECISION_KEY_MISSING");
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
    assert.equal(newView.stats.completed, 2);
    assert.equal(newView.stats.estimatedTokensSaved, 2652);
    assert.equal(newView.history.length, 2);
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

    await commands.get("codexDecision.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "DECISION_KEY_MISSING");

    assert.equal(commands.has("codexDecision.openSettings"), false);
    const ready = (await bridge({ action: "settingsRead" })).settings;
    assert.equal(ready.action, "ready");
    assert.equal(ready.hasKey, false);
    assert.equal(ready.keyLength, 0);
    assert.equal(ready.config.relevance_policy.relevant_max, 5);
    assert.deepEqual(ready.defaults, { provider:"openai", model:"gpt-6-luna", fallback_enabled: false, mode: "replace", relevance_policy: core.DEFAULT_RELEVANCE_POLICY,
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
    health = { ok: false, reason: "DECISION_HTTP_ERROR" };
    await commands.get("codexDecision.checkConnection")();
    assert.equal((await bridge({ action: "status", viewId: "view-two" })).health.reason, "DECISION_HTTP_ERROR");
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
    assert.equal(returned.stats.completed, 2, "thread activity survives a new composer view");
    const now = Date.now();
    await fs.writeFile(path.join(scoped, "logs", "hook-health.json"), JSON.stringify({
      version: 1, hook_version: "0.11.2", last_seen_ms: now,
      api_requests: 5, seen: 10, skipped: 7, errors: 1, skip_counts: { small: 7 },
    }));
    const persisted = await bridge({ action: "status", viewId: "session-switch-view" });
    assert.equal(persisted.stats.calls, 5, "API attempts include failed and pending requests");
    assert.equal(persisted.stats.skipped, 7);
    assert.equal(persisted.stats.completed, 2);
    const cachedHistoryReads = historyReads;
    await fs.writeFile(path.join(scoped, "logs", "hook-health.json"), JSON.stringify({
      version: 1, hook_version: "0.11.2", last_seen_ms: Date.now(),
      api_requests: 6, seen: 10, skipped: 7, errors: 1, skip_counts: { small: 7 },
    }));
    assert.equal((await statusAfterMetadataMutation({ viewId: "session-switch-view" })).stats.calls, 6,
      "pending API counters refresh while the event cursor is unchanged");
    assert.equal(historyReads, cachedHistoryReads, "health-only changes reuse retained history");
    const switched = await bridge({ action: "status", viewId: "session-switch-view", sessionId: "other-window" });
    assert.equal(switched.stats.calls, 0);
    assert.equal(switched.stats.skipped, 0);
    const restored = await bridge({ action: "status", viewId: "session-switch-view" });
    assert.equal(restored.stats.calls, 6);
    assert.equal(restored.stats.skipped, 7);
    assert.equal(restored.stats.completed, 2, "returning to a session restores its persisted totals");
    assert.equal(restored.classificationPulse, 0, "restoring outcomes does not replay classification");
    assert.equal((await bridge({ action: "status", viewId: "fresh-extension-view" })).stats.calls, 6,
      "a fresh controller restores attempts without observing old events");
    assert.equal((await bridge({ action: "settingsRead", viewId: "session-switch-view" })).settings.lifetime.calls, 6,
      "installation totals include the same API attempts as the selected session");
    await fs.writeFile(path.join(scoped, "stats.json"), '{"calls":"corrupt"}');
    const unavailableCounts = await statusAfterMetadataMutation({ viewId: "session-switch-view" });
    assert.equal(unavailableCounts.stats.calls, null, "a failed current read cannot display stale counts as current");
    assert.equal(unavailableCounts.stats.completed, null);
    assert.equal(unavailableCounts.stats.estimatedTokensSaved, null);
    assert.equal(unavailableCounts.hookHealth.fault, "Hook status could not be read");
    await fs.rm(path.join(scoped, "stats.json"));
    const recoveredCounts = await statusAfterMetadataMutation({ viewId: "session-switch-view" });
    assert.equal(recoveredCounts.stats.calls, 6, "repairing the file restores the durable current session");
    assert.equal(recoveredCounts.stats.completed, 2);
    assert.equal(recoveredCounts.recent, restored.recent, "cached outcome status recovers with successful metadata reads");
    await rawBridge({ action: "status", viewId: "main-home", sourceId: "main-source",
      sessionId: null, visible: true, focused: false, expectsLocalSession: false });
    assert.equal(panel.dataDirectory(), null, "deliberate home navigation clears the selected thread without composer focus");
    await rawBridge({ action: "status", viewId: "visible-background-thread", sourceId: "background-source",
      sessionId: "background-thread", visible: true, focused: false });
    assert.equal(panel.dataDirectory(), null, "background status cannot replace the selected home view");
    await bridge({ action: "status", viewId: "restored-with-terminal-focus", focused: false });
    assert.equal(panel.dataDirectory(), scoped, "returning from home restores the thread while terminal focus remains");
    await bridge({ action: "status", viewId: "restored-with-terminal-focus", visible: false, focused: false });
    await rawBridge({ action: "status", viewId: "visible-background-thread", sourceId: "background-source",
      sessionId: "background-thread", visible: true, focused: false });
    assert.equal(panel.dataDirectory(), core.sessionDirectory(directory, "background-thread"),
      "a newly visible thread can replace a selected source that has become hidden");
    await bridge({ action: "status", viewId: "restored-with-terminal-focus", focused: true });
    assert.equal(panel.dataDirectory(), scoped);

    await fs.writeFile(path.join(scoped, "config.json"), '{"schema_version":1,"enabled":true}');
    const broken = await bridge({ action: "status", viewId: "view-five" });
    assert.equal(broken.configurationError, "Decision configuration could not be read");
    assert.equal(broken.health.reason, "DECISION_CONFIG_ERROR");
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
    assert.equal(recovered.configurationError, "Decision configuration could not be read");
    assert.equal(recovered.sessionPending, false);
  } finally {
    for (const disposable of context.subscriptions.reverse()) disposable.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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
  const originalLoad = Module._load;
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
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? fake : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../../vscode-control/extension")];
    require("../../vscode-control/extension").activate(context);
  } finally {
    Module._load = originalLoad;
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
  const originalLoad = Module._load;
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
  Module._load = function (request, parent, isMain) {
    return request === "vscode" ? fake : originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../../vscode-control/extension")];
    require("../../vscode-control/extension").activate(context);
  } finally { Module._load = originalLoad; }
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
