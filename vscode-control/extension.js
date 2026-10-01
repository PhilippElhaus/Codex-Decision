"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const vscode = require("vscode");
const EXPECTED_HOOK_VERSION = require("./package.json").codexJevHookVersion;
const { LatestDecisionProvider, VIEW_ID } = require("./panel");
const {
  checkHealth, decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, savedCharacters,
  readApiKey, writeApiKey, writeSelection,
  completeLinePolicy, completeSearchRelevance,
  sessionDirectory, readHookHealth, ensureSessionDefaults,
  DEFAULT_SETTINGS, readGlobalSettings, writeGlobalSettings, readInstallationStats,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0,
    savedChars: 0, elapsedMs: 0, completed: 0 };
}

function createController(dataDirectory) {
  const state = { enabled: false, outputEnabled: false, testBuildEnabled: false, searchListingEnabled: false, needsKey: false, mode: "replace", health: null, hookHealth: null, panelFault: null, configurationError: null, sessionPending: true, viewStartedAt: Date.now(), recent: null, history: [], stats: emptyStats(), busyUntil: 0, eventSize: -1, checking: false, polling: null, callingSeen: false, viewId: null, sessionId: null, generation: 0, eventDirectory: null };
  let selectionQueue = Promise.resolve();
  let viewBaseline = Promise.resolve();
  let entering = Promise.resolve();
  let probePromise = null;
  const activeDirectory = () => sessionDirectory(dataDirectory(), state.sessionId);
  const snapshot = () => ({
    enabled: state.enabled,
    outputEnabled: state.outputEnabled,
    testBuildEnabled: state.testBuildEnabled,
    searchListingEnabled: state.searchListingEnabled,
    needsKey: state.needsKey,
    health: state.health,
    hookHealth: state.hookHealth,
    panelFault: state.panelFault,
    sessionPending: state.sessionPending,
    expectedHookVersion: EXPECTED_HOOK_VERSION,
    configurationError: state.configurationError,
    viewStartedAt: state.viewStartedAt,
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
    state.panelFault = null;
  }

  async function enterView(viewId, sessionId, expectsLocalSession = false) {
    if (typeof viewId !== "string" || !/^[\w:-]{1,96}$/.test(viewId) ||
        (sessionId != null && (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)))) {
      state.viewId = null;
      state.sessionId = null;
      state.generation += 1;
      state.eventDirectory = null;
      state.eventSize = -1;
      clearActivity();
      state.enabled = false;
      state.sessionPending = false;
      state.configurationError = "Codex session could not be identified";
      entering = Promise.resolve();
      return;
    }
    if (sessionId == null) {
      const changed = state.viewId !== viewId || state.sessionId !== null ||
        state.sessionPending === expectsLocalSession;
      if (changed) {
        state.generation += 1;
        state.eventDirectory = null;
        state.eventSize = -1;
        clearActivity();
      }
      state.viewId = viewId;
      state.sessionId = null;
      state.enabled = false;
      state.outputEnabled = false;
      state.testBuildEnabled = false;
      state.searchListingEnabled = false;
      if (changed) state.health = null;
      if (changed) state.needsKey = false;
      state.hookHealth = null;
      state.sessionPending = !expectsLocalSession;
      state.configurationError = expectsLocalSession ? "Codex session could not be identified" : null;
      entering = Promise.resolve();
      if (changed) void probe();
      return;
    }
    if (state.viewId === viewId && state.sessionId === sessionId) return entering;
    state.viewId = viewId;
    state.sessionId = sessionId;
    state.sessionPending = false;
    state.viewStartedAt = Date.now();
    state.hookHealth = null;
    const generation = ++state.generation;
    state.eventSize = -2;
    clearActivity();
    viewBaseline = (async () => {
      try {
        const offset = await readEventOffset(activeDirectory());
        if (state.generation === generation) state.eventSize = offset;
      } catch {
        if (state.generation === generation) state.eventSize = -1;
      }
    })();
    entering = viewBaseline.then(() => {
      if (state.generation === generation) return sync();
    });
    return entering;
  }

  function pulse() {
    if (!state.enabled) return;
    state.busyUntil = Date.now() + 500;
  }

  async function sync() {
    if (!state.sessionId) return;
    let generation = state.generation;
    try {
      const directory = activeDirectory();
      const directoryChanged = state.eventDirectory !== directory;
      if (directoryChanged) {
        if (state.eventDirectory !== null) {
          generation = ++state.generation;
          state.eventSize = -1;
          clearActivity();
        }
        state.eventDirectory = directory;
        state.health = null;
      }
      const [config, settings] = await Promise.all([
        ensureSessionDefaults(directory), readGlobalSettings(dataDirectory()),
      ]);
      if (generation !== state.generation) return;
      const selected = config.enabled || config.test_build_enabled || config.search_listing_enabled;
      let needsKey = false;
      try { await readApiKey(dataDirectory()); }
      catch { needsKey = true; }
      if (generation !== state.generation) return;
      state.configurationError = null;
      state.outputEnabled = config.enabled;
      state.testBuildEnabled = config.test_build_enabled;
      state.searchListingEnabled = config.search_listing_enabled;
      state.enabled = selected;
      state.mode = settings.mode;
      const wasMissingKey = state.needsKey;
      state.needsKey = needsKey;
      if (state.needsKey) state.health = { ok: false, reason: "JEV_KEY_MISSING" };
      if (!state.needsKey && (wasMissingKey || directoryChanged || !state.health)) {
        void (probePromise ? probePromise.then(() => probe()) : probe());
      }
    } catch (error) {
      if (generation !== state.generation) return;
      state.enabled = false;
      state.outputEnabled = false;
      state.testBuildEnabled = false;
      state.searchListingEnabled = false;
      state.needsKey = false;
      state.health = { ok: false, reason: "JEV_CONFIG_ERROR" };
      state.configurationError = /session ID/.test(error.message) ? "Codex session could not be identified" :
        "Jev configuration could not be read";
    }
  }

  function probe() {
    if (probePromise) return probePromise;
    const generation = state.generation;
    state.checking = true;
    pulse();
    probePromise = (async () => {
      try {
        const result = await checkHealth(dataDirectory());
        if (generation === state.generation) {
          state.health = result;
          state.needsKey = result.reason === "JEV_KEY_MISSING";
        }
      } catch {
        if (generation === state.generation) {
          state.health = { ok: false, reason: "JEV_CONFIG_ERROR" };
        }
      }
    })().finally(() => {
      state.checking = false;
      probePromise = null;
      if (generation !== state.generation) void probe();
    });
    return probePromise;
  }

  async function pollEvent() {
    if (!state.sessionId) return;
    if (state.polling) return state.polling;
    const task = (async () => {
      if (state.eventSize === -2) await viewBaseline;
      if (state.eventSize === -2) return;
      const generation = state.generation;
      try {
        const directory = activeDirectory();
        if (state.eventSize < 0) {
          const offset = await readEventOffset(directory);
          if (generation !== state.generation) return;
          state.eventSize = offset;
          const health = await readHookHealth(directory);
          if (generation === state.generation) state.hookHealth = health;
          return;
        }
        const batch = await readEventsSince(directory, state.eventSize);
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
            state.stats.calls += event.requests;
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
          } else if (event.status === "skip" && event.reason === "choice_kept_full_output") {
            state.stats.calls += event.requests;
            state.recent = event;
            pulse();
          }
          if (!state.needsKey && (event.reason === "no_evaluator" ||
              event.reason === "evaluator_unavailable")) {
            // A hook failure may be transient or unrelated to connection health.
            // Check the connection instead of leaving this window red for minutes.
            void probe();
          }
        }
        const health = await readHookHealth(directory);
        if (generation === state.generation) state.hookHealth = health;
      } catch (error) {
        if (generation !== state.generation) return;
        if (error.code !== "ENOENT") state.recent = null;
        state.hookHealth = { fault: "Hook status could not be read" };
      }
    })();
    state.polling = task;
    try { return await task; } finally { state.polling = null; }
  }

  function saveSelection(change) {
    const directory = activeDirectory();
    const sessionId = state.sessionId;
    const task = selectionQueue.then(async () => {
      // Establish the log cursor before a newly enabled hook can emit an outcome.
      await pollEvent();
      const current = await readConfig(directory);
      const next = change(current);
      await writeSelection(directory, next.enabled, next.test_build_enabled, next.search_listing_enabled);
      if (state.sessionId === sessionId) await sync();
      return snapshot();
    });
    selectionQueue = task.catch(() => {});
    return task;
  }

  async function settingsReply(request) {
    try {
      const directory = dataDirectory();
      if (request.action === "settingsRead") {
        const config = await readGlobalSettings(directory);
        let keyLength = 0;
        try { keyLength = (await readApiKey(dataDirectory())).length; } catch { /* no usable key */ }
        const lifetime = await readInstallationStats(directory);
        return { action: "ready", config,
          defaults: DEFAULT_SETTINGS,
          hasKey: keyLength > 0, keyLength, lifetime };
      }
      if (request.action === "settingsOpenLogs") {
        const parent = await fs.lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Jev data directory");
        if (!await vscode.env.openExternal(vscode.Uri.file(directory))) throw new Error("Could not open Jev logs");
        return { action: "openedLogs" };
      }
      if (request.action === "settingsTest") {
        const key = typeof request.key === "string" && request.key ? request.key : null;
        return { action: "tested", result: await checkHealth(dataDirectory(), globalThis.fetch, key) };
      }
      if (request.action === "settingsSetNeverDeleteLogs") {
        if (typeof request.neverDeleteLogs !== "boolean") throw new Error("Never delete logs must be a boolean");
        const task = selectionQueue.then(() => writeGlobalSettings(directory,
          { never_delete_logs: request.neverDeleteLogs }));
        selectionQueue = task.catch(() => {});
        await task;
        return { action: "neverDeleteLogsSaved", neverDeleteLogs: request.neverDeleteLogs };
      }
      if (request.action === "settingsSave") {
        if (!["observe", "replace"].includes(request.mode)) throw new Error("Invalid mode");
        if (!Number.isInteger(request.logLimitMb) || request.logLimitMb < 1 || request.logLimitMb > 9999 ||
            typeof request.neverDeleteLogs !== "boolean" ||
            typeof request.choiceGateEnabled !== "boolean") throw new Error("Invalid Jev settings");
        const linePolicy = completeLinePolicy(request.linePolicy);
        const searchRelevance = completeSearchRelevance(request.searchRelevance);
        const task = selectionQueue.then(async () => {
          await writeGlobalSettings(directory, { mode: request.mode, line_policy: linePolicy,
            search_relevance: searchRelevance, choice_gate_enabled: request.choiceGateEnabled,
            log_limit_mb: request.logLimitMb, never_delete_logs: request.neverDeleteLogs });
          if (request.key) await writeApiKey(dataDirectory(), request.key);
          if (state.sessionId) await sync();
          if (request.key) await probe();
        });
        selectionQueue = task.catch(() => {});
        await task;
        let keyLength = 0;
        try { keyLength = (await readApiKey(dataDirectory())).length; } catch { /* optional key */ }
        return { action: "saved", hasKey: keyLength > 0, keyLength };
      }
    } catch (error) {
      return { action: "error", message: error.message || "Jev settings failed" };
    }
    return { action: "error", message: "Unknown settings action" };
  }

  async function bridge(request) {
    await enterView(request?.viewId, request?.sessionId, request?.expectsLocalSession === true);
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
      if (!state.sessionId) return snapshot();
      return saveSelection((current) => ({
        enabled: request.feature === "output" ? request.enabled : current.enabled,
        test_build_enabled: request.feature === "test_build" ? request.enabled : current.test_build_enabled,
        search_listing_enabled: request.feature === "search_listing" ? request.enabled : current.search_listing_enabled,
      }));
    }
    return snapshot();
  }
  return { state, bridge, pollEvent, sync, probe, activeDirectory };
}

function activate(context) {
  const controllers = new Map();
  let active = null;
  const settings = () => vscode.workspace.getConfiguration("codexJev");
  const dataDirectory = () => {
    const directory = settings().get("dataDirectory") || defaultDataDirectory();
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Set codexJev.dataDirectory to the installed plugin's absolute PLUGIN_DATA path.");
    }
    return directory;
  };
  const controllerFor = (viewId) => {
    if (typeof viewId !== "string" || !/^[\w:-]{1,96}$/.test(viewId)) {
      return createController(dataDirectory);
    }
    let entry = controllers.get(viewId);
    if (!entry) {
      entry = { controller: createController(dataDirectory), lastSeen: 0 };
      controllers.set(viewId, entry);
    }
    entry.lastSeen = Date.now();
    return entry.controller;
  };
  const decisionPanel = new LatestDecisionProvider(context.extensionUri,
    () => active?.state.sessionId ? active.activeDirectory() : null, () => Date.now(),
    (fault) => { if (active) active.state.panelFault = fault; });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, decisionPanel));
  context.subscriptions.push(decisionPanel);
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.showLatestDecision", () =>
    vscode.commands.executeCommand(`${VIEW_ID}.focus`)));
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.bridge", async (request) => {
    const controller = controllerFor(request?.viewId);
    active = controller;
    const reply = await controller.bridge(request);
    const settingsSaved = request?.action === "settingsSave" && reply.settings?.action === "saved";
    const changed = request?.action === "setSelection" || request?.action === "saveApiKey" ||
      settingsSaved || request?.action === "settingsSetNeverDeleteLogs";
    if (changed) {
      await Promise.all([...controllers.values()].map(async ({ controller: other }) => {
        if (other !== controller &&
            (request.action === "saveApiKey" || settingsSaved ||
             request.action === "settingsSetNeverDeleteLogs" ||
             other.state.sessionId === controller.state.sessionId)) {
          if (other.state.sessionId) await other.sync();
          else if (request.action === "saveApiKey") await other.probe();
        }
      }));
    }
    return reply;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.checkConnection", async () => {
    await (active || createController(dataDirectory)).probe();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexJev")) {
      for (const { controller } of controllers.values()) void controller.sync();
    }
  }));

  const live = () => {
    const now = Date.now();
    for (const [id, entry] of controllers) {
      if (now - entry.lastSeen > 5 * 60_000) {
        if (active === entry.controller) active = null;
        controllers.delete(id);
      }
    }
    return [...controllers.values()].filter((entry) => now - entry.lastSeen < 10_000)
      .map((entry) => entry.controller);
  };
  const eventTimer = setInterval(() => { for (const controller of live()) void controller.pollEvent(); }, 250);
  const configTimer = setInterval(() => { for (const controller of live()) void controller.sync(); }, 10_000);
  const healthTimer = setInterval(() => { for (const controller of live()) void controller.probe(); }, 5 * 60_000);
  const retryTimer = setInterval(() => {
    for (const controller of live()) {
      if (controller.state.health?.ok === false) void controller.probe();
    }
  }, 30_000);
  context.subscriptions.push({ dispose: () => {
    clearInterval(eventTimer); clearInterval(configTimer); clearInterval(healthTimer); clearInterval(retryTimer);
  } });
}

function deactivate() {}

module.exports = { activate, deactivate };
