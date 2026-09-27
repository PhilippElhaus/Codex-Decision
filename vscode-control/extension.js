"use strict";

const path = require("node:path");
const vscode = require("vscode");
const {
  checkHealth, decisionSummary, defaultDataDirectory, estimateTokensSaved,
  isJevOutcome, outcomeLine, readConfig, readEventOffset, readEventsSince, savedCharacters,
  readApiKey, writeApiKey, writeMode, writeSelection, writeThresholds, completeThresholds,
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
  let settingsPanel = null;
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

  async function openSettings(onboarding = false) {
    if (settingsPanel) {
      settingsPanel.reveal?.(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel("codexJev.settings", "Jev settings", vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    settingsPanel = panel;
    panel.onDidDispose?.(() => { if (settingsPanel === panel) settingsPanel = null; });
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "webview", "settings.js"));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${panel.webview.cspSource};"><title>Jev settings</title><style>
      body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:740px;margin:28px auto;padding:0 24px 48px}h1{font-size:24px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:8px}p{color:var(--vscode-descriptionForeground);line-height:1.5}.field{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:11px 0}.field label{max-width:540px}small{display:block;color:var(--vscode-descriptionForeground);margin-top:3px}input[type=number],input[type=password],select{box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:7px 9px;border-radius:3px}input[type=number]{width:76px}input[type=password]{width:min(100%,480px)}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid transparent;border-radius:3px;padding:8px 14px;cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-contrastBorder,#707070)}button:disabled{opacity:.55;cursor:default}.actions{display:flex;align-items:center;gap:12px;margin-top:16px}#test-status{font-size:12px;font-weight:600}#test-status.ok,#message.ok{color:var(--vscode-testing-iconPassed,#4ec97f)}#test-status.error,#message.error{color:var(--vscode-errorForeground,#f48771)}#message{min-height:22px;margin-top:12px}body[data-onboarding=true]{min-height:calc(100vh - 76px);display:flex;flex-direction:column;justify-content:center;max-width:620px}body[data-onboarding=true] #advanced,body[data-onboarding=true] #key-heading,body[data-onboarding=true] #key-state{display:none}body[data-onboarding=true] h1{font-size:32px}body[data-onboarding=true] #key-section{margin-top:18px}body[data-onboarding=true] .field{display:block}body[data-onboarding=true] input[type=password]{width:100%;margin-top:14px}
    </style></head><body data-onboarding="${onboarding}"><h1 id="page-title">Jev settings</h1><p id="intro">Changes apply to the next tool result. Jev keeps the full result whenever a safety check fails.</p><section id="key-section"><h2 id="key-heading">API key</h2><p id="key-state">Checking saved key…</p><div class="field"><label for="key">API key<small id="key-help">The saved key is masked. Enter a new key to replace it, or leave this field unchanged to keep it.</small></label><input id="key" type="password" autocomplete="off" spellcheck="false"></div><div class="actions"><button id="test" type="button" class="secondary">Test API key</button><span id="test-status" role="status" aria-live="polite"></span></div></section><section id="advanced"><h2>Behavior</h2><div class="field"><label for="mode">Mode<small>Observe records decisions; replace shortens approved results.</small></label><select id="mode"><option value="replace">Replace</option><option value="observe">Observe</option></select></div><div id="thresholds"></div></section><div class="actions"><button id="save" type="button">Save settings</button></div><p id="message" role="status" aria-live="polite"></p><script src="${script}"></script></body></html>`;
    panel.webview.onDidReceiveMessage(async (message) => {
      const reply = (payload) => panel.webview.postMessage(payload);
      try {
        const directory = dataDirectory();
        if (message?.action === "ready") {
          const config = await readConfig(directory);
          let hasKey = false;
          try { await readApiKey(directory); hasKey = true; } catch { /* no usable key */ }
          await reply({ action: "ready", config: { ...config, thresholds: completeThresholds(config.thresholds) }, hasKey });
        } else if (message?.action === "test") {
          const key = typeof message.key === "string" && message.key ? message.key : null;
          await reply({ action: "tested", result: await checkHealth(directory, globalThis.fetch, key) });
        } else if (message?.action === "save") {
          if (message.mode !== "observe" && message.mode !== "replace") throw new Error("Invalid mode");
          if (!message.key) {
            try { await readApiKey(directory); }
            catch { throw new Error("Enter an API key before saving."); }
          }
          const thresholds = completeThresholds(message.thresholds);
          const task = selectionQueue.then(async () => {
            await writeThresholds(directory, thresholds);
            await writeMode(directory, message.mode);
            await settings().update("mode", message.mode, vscode.ConfigurationTarget.Global);
            if (message.key) await writeApiKey(directory, message.key);
            await sync();
            if (state.enabled && message.key) await probe();
          });
          selectionQueue = task.catch(() => {});
          await task;
          await reply({ action: "saved", hasKey: true });
        }
      } catch (error) {
        await reply({ action: "error", message: error.message || "Jev settings failed" });
      }
    });
    panel.webview.html = html;
  }

  context.subscriptions.push(vscode.commands.registerCommand("codexJev.bridge", async (request) => {
    await enterView(request?.viewId);
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
    if (request?.action === "openSettings") {
      await openSettings();
      return snapshot();
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
  context.subscriptions.push(vscode.commands.registerCommand("codexJev.openSettings", () => openSettings()));
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
