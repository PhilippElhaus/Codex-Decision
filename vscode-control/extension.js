"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const vscode = require("vscode");
const EXPECTED_HOOK_VERSION = require("./package.json").codexJevHookVersion;
const { LatestDecisionProvider, VIEW_ID } = require("./panel");
const {
  checkHealth, decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, savedCharacters,
  readApiKey, readLifetimeStats, writeApiKey, writeSelection, writeSettings, writeNeverDeleteLogs,
  completeLinePolicy, DEFAULT_LINE_POLICY, completeSearchRelevance, DEFAULT_SEARCH_RELEVANCE,
  sessionDirectory, readHookHealth, ensureSessionDefaults,
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
      if (state.viewId !== viewId || state.sessionId !== null || state.sessionPending === expectsLocalSession) {
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
      state.health = null;
      state.hookHealth = null;
      state.sessionPending = !expectsLocalSession;
      state.configurationError = expectsLocalSession ? "Codex session could not be identified" : null;
      entering = Promise.resolve();
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
      const config = await ensureSessionDefaults(directory);
      if (generation !== state.generation) return;
      const selected = config.enabled || config.test_build_enabled || config.search_listing_enabled;
      let needsKey = false;
      if (selected) {
        try { await readApiKey(dataDirectory()); }
        catch { needsKey = true; }
      }
      if (generation !== state.generation) return;
      state.configurationError = null;
      const wasEnabled = state.enabled;
      state.outputEnabled = config.enabled;
      state.testBuildEnabled = config.test_build_enabled;
      state.searchListingEnabled = config.search_listing_enabled;
      state.enabled = selected;
      state.mode = config.mode;
      const wasMissingKey = state.needsKey;
      state.needsKey = needsKey;
      if (state.needsKey) state.health = { ok: false, reason: "JEV_KEY_MISSING" };
      else if (state.enabled && wasMissingKey) void (probePromise ? probePromise.then(() => probe()) : probe());
      if (!state.enabled) {
        state.health = null;
      }
      if (state.enabled && !state.needsKey && (!wasEnabled || directoryChanged)) {
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
    if (!state.enabled || state.needsKey) return Promise.resolve();
    if (probePromise) return probePromise;
    state.checking = true;
    pulse();
    probePromise = (async () => {
      let active;
      try {
        const directory = dataDirectory();
        active = activeDirectory();
        const result = await checkHealth(directory);
        if (state.enabled && state.eventDirectory === active) state.health = result;
      } catch {
        if (state.enabled && (!active || state.eventDirectory === active)) {
          state.health = { ok: false, reason: "JEV_CONFIG_ERROR" };
        }
      }
    })().finally(() => {
      state.checking = false;
      probePromise = null;
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
          if (event.reason === "no_evaluator" || event.reason === "evaluator_unavailable") {
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
      const directory = activeDirectory();
      if (request.action === "settingsRead") {
        const config = await readConfig(directory);
        let keyLength = 0;
        try { keyLength = (await readApiKey(dataDirectory())).length; } catch { /* no usable key */ }
        const lifetime = await readLifetimeStats(directory);
        return { action: "ready", config: { ...config, line_policy: completeLinePolicy(config.line_policy),
          search_relevance: completeSearchRelevance(config.search_relevance),
          choice_gate_enabled: config.choice_gate_enabled ?? true,
          log_limit_mb: config.log_limit_mb ?? 50, never_delete_logs: config.never_delete_logs ?? false },
          defaults: { mode: "replace", line_policy: DEFAULT_LINE_POLICY, search_relevance: DEFAULT_SEARCH_RELEVANCE,
            choice_gate_enabled: true, log_limit_mb: 50, never_delete_logs: false },
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
        return { action: "tested", result: await checkHealth(dataDirectory(), globalThis.fetch, key) };
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
            typeof request.neverDeleteLogs !== "boolean" ||
            typeof request.choiceGateEnabled !== "boolean") throw new Error("Invalid Jev settings");
        if (!request.key) {
          try { await readApiKey(dataDirectory()); }
          catch { throw new Error("Enter an API key before saving."); }
        }
        const linePolicy = completeLinePolicy(request.linePolicy);
        const searchRelevance = completeSearchRelevance(request.searchRelevance);
        const task = selectionQueue.then(async () => {
          await writeSettings(directory, request.mode, linePolicy, request.logLimitMb,
            request.neverDeleteLogs, searchRelevance, request.choiceGateEnabled);
          if (request.key) await writeApiKey(dataDirectory(), request.key);
          await sync();
          if (state.enabled && request.key) await probe();
        });
        selectionQueue = task.catch(() => {});
        await task;
        return { action: "saved", hasKey: true, keyLength: (await readApiKey(dataDirectory())).length };
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
    if (typeof request?.sessionId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(request.sessionId)) {
      active = controller;
    }
    const reply = await controller.bridge(request);
    const settingsSaved = request?.action === "settingsSave" && reply.settings?.action === "saved";
    const changed = request?.action === "setSelection" || request?.action === "saveApiKey" ||
      settingsSaved;
    if (changed) {
      await Promise.all([...controllers.values()].map(async ({ controller: other }) => {
        if (other !== controller && other.state.sessionId &&
            (request.action === "saveApiKey" || other.state.sessionId === controller.state.sessionId)) {
          await other.sync();
        }
      }));
    }
    return reply;
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.checkConnection", async () => {
    if (!active?.state.enabled) {
      void vscode.window.showInformationMessage("Select a Jev integration to check the Jev connection.");
      return;
    }
    await active.probe();
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
      if (controller.state.enabled && controller.state.health?.ok === false) void controller.probe();
    }
  }, 30_000);
  context.subscriptions.push({ dispose: () => {
    clearInterval(eventTimer); clearInterval(configTimer); clearInterval(healthTimer); clearInterval(retryTimer);
  } });
}

function deactivate() {}

module.exports = { activate, deactivate };
