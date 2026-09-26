"use strict";

const path = require("node:path");
const vscode = require("vscode");
const {
  checkHealth, decisionSummary, defaultCredentialDirectory, defaultDataDirectory,
  isJevOutcome, outcomeLine, readConfig, readEventsSince, readRecentOutcomes, writeEnabled, writeMode,
} = require("./core");

function emptyStats() {
  return { calls: 0, candidates: 0, kept: 0, replaced: 0, checkedChars: 0, elapsedMs: 0, completed: 0 };
}

function activate(context) {
  const button = vscode.window.createStatusBarItem("jevPilot.status", vscode.StatusBarAlignment.Left, 95);
  button.name = "Jev output pilot";
  button.command = "jevPilot.selectHooks";
  button.show();
  context.subscriptions.push(button);

  const state = { enabled: false, mode: "replace", health: null, recent: null, history: [], stats: emptyStats(), busyUntil: 0, eventSize: -1, checking: false, polling: false, callingSeen: false };
  let pulseTimer;
  const settings = () => vscode.workspace.getConfiguration("jevPilot");
  const dataDirectory = () => {
    const directory = settings().get("dataDirectory") || defaultDataDirectory();
    if (typeof directory !== "string" || !path.isAbsolute(directory)) {
      throw new Error("Set jevPilot.dataDirectory to the installed plugin's absolute PLUGIN_DATA path.");
    }
    return directory;
  };
  const credentialDirectory = () => settings().get("credentialDirectory") || defaultCredentialDirectory();
  const snapshot = () => ({
    enabled: state.enabled,
    health: state.health,
    busy: state.enabled && Date.now() < state.busyUntil,
    mode: state.mode,
    recent: decisionSummary(state.recent),
    history: state.history.map(outcomeLine),
    stats: { ...state.stats },
  });

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
    const average = state.stats.completed ? Math.round(state.stats.elapsedMs / state.stats.completed) : 0;
    button.tooltip = [
      `Jev output pilot · ${status}`,
      state.enabled ? `Selected: PostToolUse output filter · ${state.mode} mode` : "Click to select a hook",
      `Since control opened: ${state.stats.calls} calls · ${state.stats.candidates} candidates · ${state.stats.kept} kept · ${state.stats.replaced} replaced`,
      `${state.stats.checkedChars.toLocaleString()} output chars checked · ${average} ms average`,
      "Recent Jev outcomes:",
      ...(state.history.length ? state.history.map(outcomeLine) : ["None yet"]),
    ].join("\n");
    button.accessibilityInformation = { label: `Jev output pilot. ${status}. ${decisionSummary(state.recent)}` };
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
      const selectedMode = settings().get("mode") || "replace";
      if (!["replace", "observe"].includes(selectedMode)) throw new Error("Invalid jevPilot.mode setting");
      let config = await readConfig(directory);
      if (config.mode !== selectedMode) config = await writeMode(directory, selectedMode);
      const wasEnabled = state.enabled;
      state.enabled = config.enabled;
      state.mode = config.mode;
      if (!state.enabled) {
        state.health = null;
        if (wasEnabled) {
          state.eventSize = -1;
          state.history = [];
          state.stats = emptyStats();
          state.recent = null;
        }
      }
      render();
      if (state.enabled && !wasEnabled) void probe();
    } catch {
      state.enabled = false;
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
    if (!state.enabled || state.polling) return;
    state.polling = true;
    try {
      if (state.eventSize < 0) {
        const { outcomes, offset } = await readRecentOutcomes(dataDirectory());
        state.eventSize = offset;
        state.history = outcomes;
        state.recent = outcomes[0] || null;
        render();
        return;
      }
      const batch = await readEventsSince(dataDirectory(), state.eventSize);
      state.eventSize = batch.offset;
      if (batch.reset) {
        state.stats = emptyStats();
        state.history = [];
        state.recent = null;
        state.callingSeen = false;
      }
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
    } finally {
      state.polling = false;
    }
  }

  function selectHooks() {
    const picker = vscode.window.createQuickPick();
    const hook = {
      label: "PostToolUse · repetitive output",
      description: "Jev checks large Bash and text-only MCP results",
      detail: `Current mode: ${state.mode}. Original output is retained when replacement is enabled.`,
    };
    picker.title = "Select Jev hooks";
    picker.placeholder = "Select hooks and press Enter; an empty selection turns Jev off";
    picker.canSelectMany = true;
    picker.items = [hook];
    picker.selectedItems = state.enabled ? [hook] : [];
    picker.onDidAccept(async () => {
      const enabled = picker.selectedItems.length > 0;
      picker.hide();
      try {
        await writeEnabled(dataDirectory(), enabled);
        state.eventSize = -1;
        await sync();
        render();
      } catch (error) {
        void vscode.window.showErrorMessage(`Jev hook selection could not be saved: ${error.message}`);
      }
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
  }

  context.subscriptions.push(vscode.commands.registerCommand("jevPilot.selectHooks", selectHooks));
  context.subscriptions.push(vscode.commands.registerCommand("jevPilot.bridge", async (request) => {
    if (request?.action === "setSelection" && typeof request.enabled === "boolean") {
      await writeEnabled(dataDirectory(), request.enabled);
      state.eventSize = -1;
      await sync();
    }
    return snapshot();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("jevPilot.checkConnection", async () => {
    if (!state.enabled) {
      void vscode.window.showInformationMessage("Select the Jev PostToolUse hook first.");
      return;
    }
    await probe();
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("jevPilot")) {
      state.eventSize = -1;
      state.stats = emptyStats();
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
