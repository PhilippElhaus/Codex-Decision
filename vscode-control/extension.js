"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const vscode = require("vscode");
const EXPECTED_HOOK_VERSION = require("./package.json").codexDecisionHookVersion;
const { LatestDecisionProvider, VIEW_ID } = require("./panel");
const {
  checkHealth, decisionSummary, defaultDataDirectory, estimateTokensSaved,
  outcomeLine, readConfig, readEventCursor, readEventsSince,
  readApiKey, writeApiKey, writeSelection,
  completeRelevancePolicy,
  sessionDirectory, readSessionActivity, readRecentOutcomes, ensureSessionDefaults,
  DEFAULT_SETTINGS, readGlobalSettings, writeGlobalSettings, readInstallationStats,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0,
    savedChars: 0, elapsedMs: 0, completed: 0 };
}

function createController(dataDirectory) {
  const state = { enabled: false, needsKey: false, mode: "replace", health: null, hookHealth: null, panelFault: null, configurationError: null, sessionPending: true, viewStartedAt: Date.now(), recent: null, history: [], stats: emptyStats(), classificationPulse: 0, eventSize: -1, eventCursor: null, checking: false, polling: null, viewId: null, sessionId: null, generation: 0, eventDirectory: null };
  let selectionQueue = Promise.resolve();
  let viewBaseline = Promise.resolve();
  let entering = Promise.resolve();
  let probePromise = null;
  const activeDirectory = () => sessionDirectory(dataDirectory(), state.sessionId);
  const providerFallback = () => ({ provider: state.provider || "openai",
    model: state.model || (state.provider === "typesafe" ? "jev-latest" : "gpt-6-luna") });
  const readSettings = () => readGlobalSettings(dataDirectory(), providerFallback());
  const writeSettings = (changes) => writeGlobalSettings(dataDirectory(), changes, providerFallback());
  const snapshot = () => ({
    provider: state.provider || "openai",
    enabled: state.enabled,
    needsKey: state.needsKey,
    health: state.health,
    hookHealth: state.hookHealth,
    panelFault: state.panelFault,
    sessionPending: state.sessionPending,
    expectedHookVersion: EXPECTED_HOOK_VERSION,
    configurationError: state.configurationError,
    viewStartedAt: state.viewStartedAt,
    classificationPulse: state.classificationPulse,
    mode: state.mode,
    recent: decisionSummary(state.recent),
    history: state.history.map(outcomeLine),
    stats: { ...state.stats, estimatedTokensSaved: state.stats.savedChars === null ? null : estimateTokensSaved(state.stats.savedChars) },
  });

  function clearActivity() {
    state.stats = emptyStats();
    state.history = [];
    state.recent = null;
    state.classificationPulse = 0;
    state.panelFault = null;
  }

  function activityUnavailable() {
    state.stats = Object.fromEntries(Object.keys(emptyStats()).map((key) => [key, null]));
    state.stats.timed = null;
    state.stats.averageMs = null;
    state.hookHealth = { fault: "Hook status could not be read" };
  }

  async function restoreActivity(directory, generation, refreshHistory = true) {
    const [activity, history] = await Promise.all([
      readSessionActivity(directory), refreshHistory ? readRecentOutcomes(directory) : null,
    ]);
    if (generation !== state.generation) return;
    const { hookHealth, ...stats } = activity;
    state.stats = { ...emptyStats(), ...stats };
    state.hookHealth = hookHealth;
    if (history !== null) {
      state.history = history;
    }
    state.recent = state.history[0] || null;
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
        const cursor = await readEventCursor(activeDirectory());
        if (state.generation === generation) { state.eventCursor = cursor; state.eventSize = cursor.offset; }
        await restoreActivity(activeDirectory(), generation);
      } catch {
        if (state.generation === generation) {
          state.eventSize = -1;
          activityUnavailable();
        }
      }
    })();
    entering = viewBaseline.then(() => {
      if (state.generation === generation) return sync();
    });
    return entering;
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
      const settings = await readGlobalSettings(dataDirectory(), {
        provider: config.provider, model: config.model,
      });
      if (generation !== state.generation) return;
      const selected = config.enabled;
      let needsKey = false;
      try { await readApiKey(dataDirectory(), settings.provider); }
      catch { needsKey = true; }
      if (generation !== state.generation) return;
      state.configurationError = null;
      state.enabled = selected;
      state.mode = settings.mode;
      state.provider = settings.provider;
      state.model = settings.model;
      const wasMissingKey = state.needsKey;
      state.needsKey = needsKey;
      if (state.needsKey) state.health = { ok: false, reason: "DECISION_KEY_MISSING" };
      if (!state.needsKey && (wasMissingKey || directoryChanged || !state.health)) {
        void (probePromise ? probePromise.then(() => probe()) : probe());
      }
    } catch (error) {
      if (generation !== state.generation) return;
      state.enabled = false;
      state.needsKey = false;
      state.health = { ok: false, reason: "DECISION_CONFIG_ERROR" };
      state.configurationError = /session ID/.test(error.message) ? "Codex session could not be identified" :
        "Decision configuration could not be read";
    }
  }

  function probe() {
    if (probePromise) return probePromise;
    const generation = state.generation;
    state.checking = true;
    probePromise = (async () => {
      try {
        const settings = await readSettings();
        const result = await checkHealth(dataDirectory(), globalThis.fetch, null, settings.provider);
        if (generation === state.generation) {
          state.provider = settings.provider;
          state.model = settings.model;
          state.health = result;
          state.needsKey = result.reason === "DECISION_KEY_MISSING";
        }
      } catch {
        if (generation === state.generation) {
          state.health = { ok: false, reason: "DECISION_CONFIG_ERROR" };
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
          const cursor = await readEventCursor(directory);
          if (generation !== state.generation) return;
          state.eventCursor = cursor;
          state.eventSize = cursor.offset;
          await restoreActivity(directory, generation);
          return;
        }
        const batch = await readEventsSince(directory, state.eventCursor);
        if (generation !== state.generation) return;
        state.eventSize = batch.offset;
        state.eventCursor = batch.cursor;
        for (const event of batch.events) {
          if (event.status === "classifying") {
            if (state.enabled) state.classificationPulse += 1;
          }
          if (!state.needsKey && (event.reason === "no_evaluator" ||
              event.reason === "evaluator_unavailable")) {
            // A hook failure may be transient or unrelated to connection health.
            // Check the connection instead of leaving this window red for minutes.
            void probe();
          }
        }
        await restoreActivity(directory, generation, batch.reset || batch.events.some((event) =>
          ["candidate", "keep", "replace"].includes(event.status)));
      } catch (error) {
        if (generation !== state.generation) return;
        if (error.code !== "ENOENT") state.recent = null;
        activityUnavailable();
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
      await writeSelection(directory, next.enabled);
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
        const config = await readSettings();
        let keyLength = 0;
        try { keyLength = (await readApiKey(dataDirectory(), config.provider)).length; } catch { /* no usable key */ }
        const lifetime = await readInstallationStats(directory);
        return { action: "ready", config,
          defaults: DEFAULT_SETTINGS,
          hasKey: keyLength > 0, keyLength, lifetime };
      }
      if (request.action === "settingsOpenLogs") {
        const parent = await fs.lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Unsafe Decision data directory");
        if (!await vscode.env.openExternal(vscode.Uri.file(directory))) throw new Error("Could not open Decision logs");
        return { action: "openedLogs" };
      }
      if (request.action === "settingsTest") {
        const key = typeof request.key === "string" && request.key ? request.key : null;
        return { action: "tested", result: await checkHealth(dataDirectory(), globalThis.fetch, key, request.provider || (await readSettings()).provider) };
      }
      if (request.action === "settingsSetNeverDeleteLogs") {
        if (typeof request.neverDeleteLogs !== "boolean") throw new Error("Never delete logs must be a boolean");
        const task = selectionQueue.then(() => writeSettings(
          { never_delete_logs: request.neverDeleteLogs }));
        selectionQueue = task.catch(() => {});
        await task;
        return { action: "neverDeleteLogsSaved", neverDeleteLogs: request.neverDeleteLogs };
      }
      if (request.action === "settingsSave") {
        if (!["observe", "replace"].includes(request.mode)) throw new Error("Invalid mode");
        if (!Number.isInteger(request.logLimitMb) || request.logLimitMb < 1 || request.logLimitMb > 9999 ||
            typeof request.neverDeleteLogs !== "boolean") throw new Error("Invalid Decision settings");
        const relevancePolicy = completeRelevancePolicy(request.relevancePolicy);
        const selected = request.provider || (await readSettings()).provider;
        const model = selected === "openai" ? "gpt-6-luna" : "jev-latest";
        if (!["openai", "typesafe"].includes(selected)) throw new Error("Invalid decision provider");
        const task = selectionQueue.then(async () => {
          await writeSettings({ provider: selected, model, mode: request.mode, relevance_policy: relevancePolicy,
            log_limit_mb: request.logLimitMb, never_delete_logs: request.neverDeleteLogs });
          if (request.key) await writeApiKey(dataDirectory(), request.key, selected);
          if (state.sessionId) await sync();
          await probe();
        });
        selectionQueue = task.catch(() => {});
        await task;
        let keyLength = 0;
        try { keyLength = (await readApiKey(dataDirectory(), selected)).length; } catch { /* optional key */ }
        return { action: "saved", hasKey: keyLength > 0, keyLength };
      }
    } catch (error) {
      return { action: "error", message: error.message || "Decision settings failed" };
    }
    return { action: "error", message: "Unknown settings action" };
  }

  async function bridge(request) {
    await enterView(request?.viewId, request?.sessionId, request?.expectsLocalSession === true);
    if (["openTypeSafe", "openProvider"].includes(request?.action)) {
      try {
        const externalOpen = await vscode.env.openExternal(vscode.Uri.parse((request.provider || state.provider) === "typesafe" ? "https://typesafe.ai/" : "https://platform.openai.com/api-keys"));
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
        typeof request.key === "string" ? request.key : "", request.provider || (await readSettings()).provider);
      return { ...snapshot(), keyTest };
    }
    if (request?.action === "saveApiKey") {
      try {
        const selected = request.provider || (await readSettings()).provider;
        if (!["openai", "typesafe"].includes(selected)) throw new Error("Invalid decision provider");
        await writeApiKey(dataDirectory(), request.key, selected);
        await writeSettings({ provider: selected, model: selected === "openai" ? "gpt-6-luna" : "jev-latest" });
        state.provider = selected;
        state.model = selected === "openai" ? "gpt-6-luna" : "jev-latest";
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
      return saveSelection(() => ({ enabled: request.enabled }));
    }
    await pollEvent();
    return snapshot();
  }
  return { state, bridge, pollEvent, sync, probe, activeDirectory };
}

function activate(context) {
  const controllers = new Map();
  let active = null;
  let activeSourceId = null;
  let activeSourceVisible = null;
  const settings = () => vscode.workspace.getConfiguration("codexDecision");
  const dataDirectory = () => {
    const directory = settings().get("dataDirectory") || defaultDataDirectory();
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Set codexDecision.dataDirectory to the installed plugin's absolute PLUGIN_DATA path.");
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
  context.subscriptions.push(vscode.commands.registerCommand("codexDecision.showLatestDecision", () =>
    vscode.commands.executeCommand(`${VIEW_ID}.focus`)));
  context.subscriptions.push(vscode.commands.registerCommand("codexDecision.bridge", async (request) => {
    const controller = controllerFor(request?.viewId);
    const sourceId = typeof request?.sourceId === "string" && /^[\w:-]{1,96}$/.test(request.sourceId)
      ? request.sourceId : null;
    const previousController = active;
    const previousSession = active?.state.sessionId;
    if (sourceId !== null && sourceId === activeSourceId && typeof request.visible === "boolean") {
      activeSourceVisible = request.visible;
    }
    // Route IDs change when Codex restores or navigates a chat. Keep following
    // the selected visible webview even while keyboard focus is in Terminal.
    const followsSelectedView = sourceId !== null && sourceId === activeSourceId && request.visible === true;
    if (request?.focused === true || request?.action === "setSelection" || followsSelectedView) {
      active = controller;
      activeSourceId = sourceId;
      activeSourceVisible = request.visible ?? null;
    }
    const reply = await controller.bridge(request);
    // A restored Codex view can start while focus remains in the Decision panel.
    if ((!active || activeSourceVisible === false && request?.visible === true) &&
        controller.state.sessionId && request?.visible !== false) {
      active = controller;
      activeSourceId = sourceId;
      activeSourceVisible = request?.visible ?? null;
    }
    if (active === controller && (active !== previousController ||
        active.state.sessionId !== previousSession)) void decisionPanel.refresh();
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
  context.subscriptions.push(vscode.commands.registerCommand("codexDecision.checkConnection", async () => {
    await (active || createController(dataDirectory)).probe();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexDecision")) {
      for (const { controller } of controllers.values()) void controller.sync();
    }
  }));

  const live = () => {
    const now = Date.now();
    for (const [id, entry] of controllers) {
      if (now - entry.lastSeen > 5 * 60_000) {
        if (active === entry.controller) { active = null; activeSourceId = null; activeSourceVisible = null; }
        controllers.delete(id);
      }
    }
    return [...controllers.values()].filter((entry) => now - entry.lastSeen < 10_000)
      .map((entry) => entry.controller);
  };
  const eventTimer = setInterval(() => { for (const controller of live()) void controller.pollEvent(); }, 1000);
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
