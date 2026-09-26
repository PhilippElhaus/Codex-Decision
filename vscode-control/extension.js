"use strict";

const path = require("node:path");
const vscode = require("vscode");
const {
  activitySummary, checkHealth, decisionSummary, defaultCredentialDirectory, defaultDataDirectory,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, writeMode, writeSelection,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0, elapsedMs: 0, completed: 0 };
}

function activate(context) {
  const button = vscode.window.createStatusBarItem("codexJev.status", vscode.StatusBarAlignment.Left, 95);
  button.name = "Codex Jev";
  button.command = "codexJev.selectHooks";
  button.show();
  context.subscriptions.push(button);

  const state = { enabled: false, outputEnabled: false, testBuildEnabled: false, searchListingEnabled: false, mode: "replace", health: null, recent: null, history: [], stats: emptyStats(), busyUntil: 0, eventSize: -1, checking: false, polling: null, callingSeen: false, viewId: null, generation: 0, eventDirectory: null };
  let pulseTimer;
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
  const credentialDirectory = () => settings().get("credentialDirectory") || defaultCredentialDirectory();
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
    render();
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

  function render() {
    const busy = state.enabled && Date.now() < state.busyUntil;
    const color = !state.enabled ? "disabledForeground" : busy ? "charts.blue" :
      state.health?.ok === true ? "testing.iconPassed" :
      state.health?.ok === false ? "testing.iconFailed" : "statusBar.foreground";
    button.color = new vscode.ThemeColor(color);
    button.text = state.enabled && state.mode === "observe" ? "$(circle-filled) jev · OBS" : "$(circle-filled) jev";
    const status = !state.enabled ? "Off · no hooks selected" :
      state.health?.ok === true ? `Connected · ${state.health.model}` :
      state.health?.ok === false ? `Unavailable · ${state.health.reason}` : "Checking connection";
    button.tooltip = [
      `Codex Jev · ${status}`,
      state.enabled ? `Selected: ${[state.outputEnabled && "Jev output", state.testBuildEnabled && "Jev test/build", state.searchListingEnabled && "Jev search/listing"].filter(Boolean).join(" + ")} · ${state.mode} mode` : "Click to select a use case",
      `Since this view opened: ${activitySummary(state.stats)}`,
      "Recent Jev outcomes:",
      ...(state.history.length ? state.history.map(outcomeLine) : ["None yet"]),
    ].join("\n");
    button.accessibilityInformation = { label: `Codex Jev. ${status}. ${decisionSummary(state.recent)}` };
  }

  function pulse() {
    if (!state.enabled) return;
    state.busyUntil = Date.now() + 500;
    render();
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(render, 510);
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
      render();
      if (state.enabled && !wasEnabled) void probe();
    } catch {
      state.enabled = false;
      state.outputEnabled = false;
      state.testBuildEnabled = false;
      state.searchListingEnabled = false;
      state.health = null;
      render();
    }
  }

  async function probe() {
    if (!state.enabled || state.checking) return;
    state.checking = true;
    pulse();
    try {
      const result = await checkHealth(credentialDirectory());
      if (state.enabled) state.health = result;
    } finally {
      state.checking = false;
      render();
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
          render();
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
        if (batch.events.length || batch.reset) render();
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

  function selectHooks() {
    const picker = vscode.window.createQuickPick();
    const output = {
      label: "Output filter",
      description: "Jev checks large Bash and text-only MCP results",
      detail: `Current mode: ${state.mode}. Original output is retained when replacement is enabled.`,
    };
    const testBuild = {
      label: "Test/build logs",
      description: "Jev checks routine pass and progress lines before trimming",
      detail: "Keeps failures, warnings, summaries, and the exact original.",
    };
    const searchListing = {
      label: "Search/listing",
      description: "Jev ranks broad rg results and file listings for the current task",
      detail: "Retains uncertain groups and saves the exact original before replacement.",
    };
    picker.title = "Select Jev use cases";
    picker.placeholder = "Select use cases and press Enter; an empty selection turns Jev off";
    picker.canSelectMany = true;
    picker.items = [output, testBuild, searchListing];
    picker.selectedItems = [state.outputEnabled && output, state.testBuildEnabled && testBuild, state.searchListingEnabled && searchListing].filter(Boolean);
    picker.onDidAccept(async () => {
      const outputEnabled = picker.selectedItems.includes(output);
      const testBuildEnabled = picker.selectedItems.includes(testBuild);
      const searchListingEnabled = picker.selectedItems.includes(searchListing);
      picker.hide();
      try {
        await saveSelection(() => ({ enabled: outputEnabled, test_build_enabled: testBuildEnabled, search_listing_enabled: searchListingEnabled }));
        render();
      } catch (error) {
        void vscode.window.showErrorMessage(`Jev hook selection could not be saved: ${error.message}`);
      }
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
  }

  context.subscriptions.push(vscode.commands.registerCommand("codexJev.selectHooks", selectHooks));
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
      void vscode.window.showInformationMessage("Select a Jev filter to check the Jev connection.");
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
  context.subscriptions.push({ dispose: () => { clearTimeout(pulseTimer); clearInterval(eventTimer); clearInterval(configTimer); clearInterval(healthTimer); } });
  render();
  void sync();
}

function deactivate() {}

module.exports = { activate, deactivate };
