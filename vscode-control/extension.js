"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const vscode = require("vscode");
const { LatestDecisionProvider, VIEW_ID } = require("./panel");
const {
  checkHealth, decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, savedCharacters,
  readApiKey, readLifetimeStats, writeApiKey, writeMode, writeSelection, writeSettings, writeNeverDeleteLogs,
  completeLinePolicy, DEFAULT_LINE_POLICY,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0,
    savedChars: 0, elapsedMs: 0, completed: 0 };
}

function activate(context) {
  const state = { enabled: false, outputEnabled: false, testBuildEnabled: false, searchListingEnabled: false, needsKey: false, mode: "replace", health: null, recent: null, history: [], stats: emptyStats(), busyUntil: 0, eventSize: -1, checking: false, polling: null, callingSeen: false, viewId: null, generation: 0, eventDirectory: null };
  let selectionQueue = Promise.resolve();
  let viewBaseline = Promise.resolve();
  let probePromise = null;
  const settings = () => vscode.workspace.getConfiguration("codexJev");
  const dataDirectory = () => {
    const directory = settings().get("dataDirectory") || defaultDataDirectory();
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Set codexJev.dataDirectory to the installed plugin's absolute PLUGIN_DATA path.");
    }
    return directory;
  };
  const decisionPanel = new LatestDecisionProvider(context.extensionUri, dataDirectory);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, decisionPanel));
  context.subscriptions.push(decisionPanel);
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.showLatestDecision", () =>
    vscode.commands.executeCommand(`${VIEW_ID}.focus`)));
  const snapshot = () => ({
    enabled: state.enabled,
    outputEnabled: state.outputEnabled,
    testBuildEnabled: state.testBuildEnabled,
    searchListingEnabled: state.searchListingEnabled,
    needsKey: state.needsKey,
    health: state.health,
    busy: state.enabled && Date.now() < state.busyUntil,
    mode: state.mode,
    recent: decisionSummary(state.recent),
    history: state.history.map(outcomeLine),
    stats: { ...state.stats, estimatedTokensSaved: estimateTokensSaved(state.stats.savedChars) },
  });

  function clearActivity() {
    state.stats = emptyStats();
    state.history = [];
    state.recent = null;
    state.callingSeen = false;
    state.busyUntil = 0;
  }

  async function enterView(viewId) {
    if (typeof viewId !== "string" || !/^[\w:-]{1,96}$/.test(viewId) || state.viewId === viewId) return;
    state.viewId = viewId;
    const generation = ++state.generation;
    state.eventSize = -2;
    clearActivity();
    viewBaseline = (async () => {
      try {
        const offset = await readEventOffset(dataDirectory());
        if (state.generation === generation) state.eventSize = offset;
      } catch {
        if (state.generation === generation) state.eventSize = -1;
      }
    })();
    await viewBaseline;
  }

  function pulse() {
    if (!state.enabled) return;
    state.busyUntil = Date.now() + 500;
  }

  async function sync() {
    try {
      const directory = dataDirectory();
      const directoryChanged = state.eventDirectory !== directory;
      if (directoryChanged) {
        if (state.eventDirectory !== null) {
          state.generation += 1;
          state.eventSize = -1;
          clearActivity();
        }
        state.eventDirectory = directory;
        state.health = null;
      }
      const selectedMode = settings().get("mode") || "replace";
      if (!["replace", "observe"].includes(selectedMode)) throw new Error("Invalid codexJev.mode setting");
      let config = await readConfig(directory);
      if (config.mode !== selectedMode) config = await writeMode(directory, selectedMode);
      const wasEnabled = state.enabled;
      state.outputEnabled = config.enabled;
      state.testBuildEnabled = config.test_build_enabled;
      state.searchListingEnabled = config.search_listing_enabled;
      state.enabled = state.outputEnabled || state.testBuildEnabled || state.searchListingEnabled;
      state.mode = config.mode;
      const wasMissingKey = state.needsKey;
      if (state.enabled) {
        try { await readApiKey(directory); state.needsKey = false; }
        catch { state.needsKey = true; }
      } else state.needsKey = false;
      if (state.needsKey) state.health = { ok: false, reason: "JEV_KEY_MISSING" };
      else if (state.enabled && wasMissingKey) void (probePromise ? probePromise.then(() => probe()) : probe());
      if (!state.enabled) {
        state.health = null;
      }
      if (state.enabled && (!wasEnabled || directoryChanged)) {
        void (probePromise ? probePromise.then(() => probe()) : probe());
      }
    } catch {
      state.enabled = false;
      state.outputEnabled = false;
      state.testBuildEnabled = false;
      state.searchListingEnabled = false;
      state.needsKey = false;
      state.health = null;
    }
  }

  function probe() {
    if (!state.enabled) return Promise.resolve();
    if (probePromise) return probePromise;
    state.checking = true;
    pulse();
    probePromise = (async () => {
      try {
        const directory = dataDirectory();
        const result = await checkHealth(directory);
        if (state.enabled && state.eventDirectory === directory) state.health = result;
      } catch {
        if (state.enabled) state.health = { ok: false, reason: "JEV_CONFIG_ERROR" };
      }
    })().finally(() => {
      state.checking = false;
      probePromise = null;
    });
    return probePromise;
  }

  async function pollEvent() {
    if (state.polling) return state.polling;
    const task = (async () => {
      if (state.eventSize === -2) await viewBaseline;
      if (state.eventSize === -2) return;
      const generation = state.generation;
      try {
        if (state.eventSize < 0) {
          const offset = await readEventOffset(dataDirectory());
          if (generation !== state.generation) return;
          state.eventSize = offset;
          return;
        }
        const batch = await readEventsSince(dataDirectory(), state.eventSize);
        if (generation !== state.generation) return;
        state.eventSize = batch.offset;
        if (batch.reset) clearActivity();
        for (const event of batch.events) {
          if (event.status === "calling") {
            state.stats.calls += 1;
            state.recent = event;
            state.callingSeen = true;
            pulse();
          } else if (isJevOutcome(event)) {
            if (!state.callingSeen) pulse();
            state.stats.completed += 1;
            state.stats.checkedChars += event.original_chars;
            state.stats.savedChars += savedCharacters(event);
            state.stats.elapsedMs += event.elapsed_ms;
            if (event.status === "candidate") state.stats.candidates += 1;
            else if (event.status === "replace") state.stats.replaced += 1;
            else state.stats.kept += 1;
            state.history.unshift(event);
            state.history.length = Math.min(state.history.length, 3);
            state.recent = event;
            state.callingSeen = false;
          }
          if (event.reason === "no_evaluator" || event.reason === "evaluator_unavailable") {
            // A hook failure may be transient or unrelated to connection health.
            // Check the connection instead of leaving this window red for minutes.
            void probe();
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") state.recent = null;
      }
    })();
    state.polling = task;
    try { return await task; } finally { state.polling = null; }
  }

  function saveSelection(change) {
    const task = selectionQueue.then(async () => {
      // Establish the log cursor before a newly enabled hook can emit an outcome.
      await pollEvent();
      const current = await readConfig(dataDirectory());
      const next = change(current);
      await writeSelection(dataDirectory(), next.enabled, next.test_build_enabled, next.search_listing_enabled);
      await sync();
      return snapshot();
    });
    selectionQueue = task.catch(() => {});
    return task;
  }

  async function settingsReply(request) {
    try {
      const directory = dataDirectory();
      if (request.action === "settingsRead") {
        const config = await readConfig(directory);
        let keyLength = 0;
        try { keyLength = (await readApiKey(directory)).length; } catch { /* no usable key */ }
        const lifetime = await readLifetimeStats(directory);
        return { action: "ready", config: { ...config, line_policy: completeLinePolicy(config.line_policy),
          log_limit_mb: config.log_limit_mb ?? 50, never_delete_logs: config.never_delete_logs ?? false },
          defaults: { mode: "replace", line_policy: DEFAULT_LINE_POLICY,
            log_limit_mb: 50, never_delete_logs: false },
          hasKey: keyLength > 0, keyLength, lifetime };
      }
      if (request.action === "settingsOpenLogs") {
        const parent = await fs.lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Jev data directory");
        let target = path.join(directory, "logs");
        try {
          const details = await fs.lstat(target);
          if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe Jev logs directory");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          target = directory;
        }
        if (!await vscode.env.openExternal(vscode.Uri.file(target))) throw new Error("Could not open Jev logs");
        return { action: "openedLogs" };
      }
      if (request.action === "settingsTest") {
        const key = typeof request.key === "string" && request.key ? request.key : null;
        return { action: "tested", result: await checkHealth(directory, globalThis.fetch, key) };
      }
      if (request.action === "settingsSetNeverDeleteLogs") {
        if (typeof request.neverDeleteLogs !== "boolean") throw new Error("Never delete logs must be a boolean");
        const task = selectionQueue.then(() => writeNeverDeleteLogs(directory, request.neverDeleteLogs));
        selectionQueue = task.catch(() => {});
        await task;
        return { action: "neverDeleteLogsSaved", neverDeleteLogs: request.neverDeleteLogs };
      }
      if (request.action === "settingsSave") {
        if (!["observe", "replace"].includes(request.mode)) throw new Error("Invalid mode");
        if (!Number.isInteger(request.logLimitMb) || request.logLimitMb < 1 || request.logLimitMb > 9999 ||
            typeof request.neverDeleteLogs !== "boolean") throw new Error("Log retention must be 1 to 9999 MB");
        if (!request.key) {
          try { await readApiKey(directory); }
          catch { throw new Error("Enter an API key before saving."); }
        }
        const linePolicy = completeLinePolicy(request.linePolicy);
        const task = selectionQueue.then(async () => {
          await writeSettings(directory, request.mode, linePolicy, request.logLimitMb, request.neverDeleteLogs);
          await settings().update("mode", request.mode, vscode.ConfigurationTarget.Global);
          if (request.key) await writeApiKey(directory, request.key);
          await sync();
          if (state.enabled && request.key) await probe();
        });
        selectionQueue = task.catch(() => {});
        await task;
        return { action: "saved", hasKey: true, keyLength: (await readApiKey(directory)).length };
      }
    } catch (error) {
      return { action: "error", message: error.message || "Jev settings failed" };
    }
    return { action: "error", message: "Unknown settings action" };
  }

  context.subscriptions.push(vscode.commands.registerCommand("codexJev.bridge", async (request) => {
    await enterView(request?.viewId);
    if (request?.action === "openTypeSafe") {
      try {
        const externalOpen = await vscode.env.openExternal(vscode.Uri.parse("https://typesafe.ai/"));
        return { ...snapshot(), externalOpen: externalOpen === true };
      } catch {
        return { ...snapshot(), externalOpen: false };
      }
    }
    if (["settingsRead", "settingsTest", "settingsSave", "settingsSetNeverDeleteLogs", "settingsOpenLogs"].includes(request?.action)) {
      return { ...snapshot(), settings: await settingsReply(request) };
    }
    if (request?.action === "testApiKey") {
      const keyTest = await checkHealth(dataDirectory(), globalThis.fetch,
        typeof request.key === "string" ? request.key : "");
      return { ...snapshot(), keyTest };
    }
    if (request?.action === "saveApiKey") {
      try {
        await writeApiKey(dataDirectory(), request.key);
        state.needsKey = false;
        if (probePromise) await probePromise;
        await probe();
        return { ...snapshot(), keySaved: true };
      } catch {
        return { ...snapshot(), keySaveError: "Could not save API key" };
      }
    }
    if (request?.action === "retryConnection") {
      await probe();
      return snapshot();
    }
    if (request?.action === "setSelection" && typeof request.enabled === "boolean") {
      return saveSelection((current) => ({
        enabled: request.feature === "output" ? request.enabled : current.enabled,
        test_build_enabled: request.feature === "test_build" ? request.enabled : current.test_build_enabled,
        search_listing_enabled: request.feature === "search_listing" ? request.enabled : current.search_listing_enabled,
      }));
    }
    return snapshot();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.checkConnection", async () => {
    if (!state.enabled) {
      void vscode.window.showInformationMessage("Select a Jev integration to check the Jev connection.");
      return;
    }
    await probe();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexJev")) {
      void sync();
    }
  }));

  const eventTimer = setInterval(() => { void pollEvent(); }, 250);
  const configTimer = setInterval(() => { void sync(); }, 10_000);
  const healthTimer = setInterval(() => { void probe(); }, 5 * 60_000);
  const retryTimer = setInterval(() => {
    if (state.enabled && state.health?.ok === false) void probe();
  }, 30_000);
  context.subscriptions.push({ dispose: () => {
    clearInterval(eventTimer); clearInterval(configTimer); clearInterval(healthTimer); clearInterval(retryTimer);
  } });
  void sync();
}

function deactivate() {}

module.exports = { activate, deactivate };
