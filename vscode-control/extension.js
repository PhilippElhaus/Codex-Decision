"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const {
  checkHealth, decisionSummary, defaultCredentialDirectory, defaultDataDirectory,
  readConfig, readLatestEvent, writeEnabled,
} = require("./core");

function activate(context) {
  const button = vscode.window.createStatusBarItem("jevPilot.status", vscode.StatusBarAlignment.Left, 95);
  button.name = "Jev output pilot";
  button.command = "jevPilot.selectHooks";
  button.show();
  context.subscriptions.push(button);

  const state = { enabled: false, mode: "observe", health: null, recent: null, busyUntil: 0, eventSize: -1, checking: false, callingSeen: false };
  let pulseTimer;
  const settings = () => vscode.workspace.getConfiguration("jevPilot");
  const dataDirectory = () => settings().get("dataDirectory") || defaultDataDirectory();
  const credentialDirectory = () => settings().get("credentialDirectory") || defaultCredentialDirectory();
  const snapshot = () => ({
    enabled: state.enabled,
    health: state.health,
    busy: state.enabled && Date.now() < state.busyUntil,
    mode: state.mode,
    recent: decisionSummary(state.recent),
  });

  function render() {
    const busy = state.enabled && Date.now() < state.busyUntil;
    const color = !state.enabled ? "disabledForeground" : busy ? "charts.blue" :
      state.health?.ok === true ? "testing.iconPassed" :
      state.health?.ok === false ? "testing.iconFailed" : "statusBar.foreground";
    button.color = new vscode.ThemeColor(color);
    button.text = "$(circle-filled) jev";
    const status = !state.enabled ? "Off · no hooks selected" :
      state.health?.ok === true ? `Connected · ${state.health.model}` :
      state.health?.ok === false ? `Unavailable · ${state.health.reason}` : "Checking connection";
    button.tooltip = [
      `Jev output pilot · ${status}`,
      state.enabled ? `Selected: PostToolUse output filter · ${state.mode} mode` : "Click to select a hook",
      decisionSummary(state.recent),
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
      const config = await readConfig(dataDirectory());
      const wasEnabled = state.enabled;
      state.enabled = config.enabled;
      state.mode = config.mode;
      if (!state.enabled) state.health = null;
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
    if (!state.enabled) return;
    try {
      const { size } = await fs.stat(path.join(dataDirectory(), "events.jsonl"));
      if (size === state.eventSize) return;
      state.eventSize = size;
      const event = await readLatestEvent(dataDirectory());
      if (!event) return;
      state.recent = event;
      if (event.status === "calling") {
        state.callingSeen = true;
        pulse();
      } else {
        if (!state.callingSeen &&
            ["jev_keep", "jev_replace", "observe", "mcp_observe_only"].includes(event.reason)) pulse();
        state.callingSeen = false;
      }
      if (event.reason === "no_evaluator" || event.reason === "evaluator_unavailable") {
        state.health = { ok: false, reason: event.reason === "no_evaluator" ? "HOOK_KEY_MISSING" : "JEV_UNAVAILABLE" };
      }
      render();
    } catch (error) {
      if (error.code !== "ENOENT") state.recent = null;
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
        if (!enabled) state.recent = null;
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
      if (!request.enabled) state.recent = null;
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
    if (event.affectsConfiguration("jevPilot")) { state.eventSize = -1; void sync(); }
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
