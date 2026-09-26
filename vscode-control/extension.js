"use strict";

const path = require("node:path");
const vscode = require("vscode");
const {
  checkHealth, decisionSummary, defaultDataDirectory,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, writeMode, writeSelection,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0, elapsedMs: 0, completed: 0 };
}

function activate(context) {
  const state = { enabled: false, outputEnabled: false, testBuildEnabled: false, searchListingEnabled: false, mode: "replace", health: null, recent: null, history: [], stats: emptyStats(), busyUntil: 0, eventSize: -1, checking: false, polling: null, callingSeen: false, viewId: null, generation: 0, eventDirectory: null };
  let selectionQueue = Promise.resolve();
  let viewBaseline = Promise.resolve();
  const settings = () => vscode.workspace.getConfiguration("codexJev");
  const dataDirectory = () => {
    const directory = settings().get("dataDirectory") || defaultDataDirectory();
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Set codexJev.dataDirectory to the installed plugin's absolute PLUGIN_DATA path.");
    }
    return directory;
  };
  const snapshot = () => ({
    enabled: state.enabled,
    outputEnabled: state.outputEnabled,
    testBuildEnabled: state.testBuildEnabled,
    searchListingEnabled: state.searchListingEnabled,
    health: state.health,
    busy: state.enabled && Date.now() < state.busyUntil,
    mode: state.mode,
    recent: decisionSummary(state.recent),
    history: state.history.map(outcomeLine),
    stats: { ...state.stats },
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
      if (state.eventDirectory !== directory) {
        if (state.eventDirectory !== null) {
          state.generation += 1;
          state.eventSize = -1;
          clearActivity();
        }
        state.eventDirectory = directory;
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
      if (!state.enabled) state.health = null;
      if (state.enabled && !wasEnabled) void probe();
    } catch {
      state.enabled = false;
      state.outputEnabled = false;
      state.testBuildEnabled = false;
      state.searchListingEnabled = false;
      state.health = null;
    }
  }

  async function probe() {
    if (!state.enabled || state.checking) return;
    state.checking = true;
    pulse();
    try {
      const result = await checkHealth(dataDirectory());
      if (state.enabled) state.health = result;
    } finally {
      state.checking = false;
    }
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
            state.health = { ok: false, reason: event.reason === "no_evaluator" ? "HOOK_KEY_MISSING" : "JEV_UNAVAILABLE" };
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

  context.subscriptions.push(vscode.commands.registerCommand("codexJev.bridge", async (request) => {
    await enterView(request?.viewId);
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
  context.subscriptions.push({ dispose: () => { clearInterval(eventTimer); clearInterval(configTimer); clearInterval(healthTimer); } });
  void sync();
}

function deactivate() {}

module.exports = { activate, deactivate };
