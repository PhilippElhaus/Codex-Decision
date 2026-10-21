"use strict";

const vscode = require("vscode");
const { readLatestPanelDecision, readPanelActivity } = require("./panel-state");
const { readRawSkipPreference, writeRawSkipPreference } = require("./raw-skip-state");

const VIEW_ID = "codexDecisionDecision";
const MIN_SETTLED_MS = 1000;
// Match the line animation in webview/decision-panel.js before accepting a newer snapshot.
const BAR_FILL_MS = 900;
const PERCENT_FADE_MS = 180;
const MIN_DISPLAY_MS = BAR_FILL_MS + PERCENT_FADE_MS + MIN_SETTLED_MS;

class LatestDecisionProvider {
  constructor(extensionUri, dataDirectory, now = () => Date.now(), onFault = () => {}, options = {}) {
    this.extensionUri = extensionUri;
    this.dataDirectory = dataDirectory;
    this.now = now;
    this.onFault = onFault;
    this.rootDataDirectory = options.rootDataDirectory || (() => null);
    this.workComplete = options.workComplete || null;
    this.view = null;
    this.timer = null;
    this.pending = null;
    this.cache = {};
    this.rawCache = {};
    this.rawTogglePending = false;
    this.rawToggle = null;
    this.lastMessage = "";
    this.lastActivity = "";
    this.displayedDecision = null;
    this.lastDecisionId = null;
    this.nextDecisionAt = 0;
    this.directory = undefined;
    this.rootDirectory = undefined;
    this.generation = 0;
    this.awaitingReady = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    this.generation += 1;
    this.awaitingReady = true;
    this.lastMessage = "";
    this.lastActivity = "";
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview")] };
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "decision-panel.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "decision-panel.js"));
    const totalsScript = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "decision-totals.js"));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body><main id="app" aria-live="polite"></main><script src="${totalsScript}"></script><script src="${script}"></script></body></html>`;
    const ready = webview.onDidReceiveMessage((message) => {
      if (this.view === view && message?.type === "ready") {
        this.awaitingReady = false;
        this.generation += 1;
        this.lastMessage = "";
        this.lastActivity = "";
        this.lastDecisionId = null;
        this.nextDecisionAt = 0;
        void this.refresh();
      }
      if (this.view === view && !this.awaitingReady && message?.type === "set-raw-skips" &&
          typeof message.enabled === "boolean") {
        let selected, root;
        try { selected = this.dataDirectory(); root = this.rootDataDirectory(); } catch { return; }
        // A click on a stale panel must not enable capture for a newly selected thread.
        const pendingScope = this.rawTogglePending && message.scope === this.rawToggle?.scope;
        if ((message.scope === this.generation || pendingScope) &&
            selected === this.directory && root === this.rootDirectory) {
          void this.setRawSkips(message.enabled);
        }
        else void this.refresh();
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (this.view !== view) return;
      if (view.visible) this.start();
      else this.stop();
    });
    view.onDidDispose(() => {
      ready.dispose();
      visibility.dispose();
      if (this.view === view) {
        this.stop();
        this.view = null;
        this.generation += 1;
      }
    });
    // Subscribe before loading the document, and wait for its message listener.
    webview.html = html;
    if (view.visible) this.start();
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => { void this.refresh(); }, 1000);
    void this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextDecisionAt = 0;
  }

  async refresh() {
    if (!this.view?.visible || this.awaitingReady || this.rawTogglePending) return;
    let directory, rootDirectory;
    let directoryFault = false;
    try { directory = this.dataDirectory(); rootDirectory = this.rootDataDirectory(); }
    catch {
      directoryFault = true;
      directory = null;
      rootDirectory = null;
    }
    if (directory !== this.directory || rootDirectory !== this.rootDirectory) {
      this.directory = directory;
      this.rootDirectory = rootDirectory;
      this.generation += 1;
      this.cache = {};
      this.rawCache = {};
      this.lastMessage = "";
      this.lastActivity = "";
      this.displayedDecision = null;
      this.lastDecisionId = null;
      this.nextDecisionAt = 0;
    }
    if (this.pending) return this.pending;
    const generation = this.generation;
    const view = this.view;
    const current = () => {
      if (generation !== this.generation || view !== this.view) return false;
      try { return directory === this.dataDirectory() && rootDirectory === this.rootDataDirectory(); }
      catch { return directoryFault; }
    };
    const task = (async () => {
      let message;
      let serialized;
      let activitySerialized;
      try {
        if (directoryFault) throw new Error("Decision data directory is unavailable");
        const refreshDecision = this.now() >= this.nextDecisionAt;
        const [decision, activity, workComplete] = await Promise.all([
          directory ? refreshDecision ? readLatestPanelDecision(directory, this.cache) : this.displayedDecision : null,
          directory ? readPanelActivity(directory, this.rawCache) : rootDirectory ?
            readRawSkipPreference(rootDirectory).then(enabled => ({ rawSkips: { enabled: enabled ?? false, entries: [] } }))
              .catch(() => ({ rawSkips: { enabled: false, entries: [], unavailable: true } })) : null,
          directory && this.workComplete ? Promise.resolve().then(() => this.workComplete()).catch(() => false) : false,
        ]);
        if (!current()) return;
        if (activity?.rawSkips) activity.rawSkips.scope = generation;
        if (activity && this.workComplete) activity.workComplete = workComplete === true;
        this.onFault(null);
        serialized = refreshDecision ? JSON.stringify(decision) : this.lastMessage;
        activitySerialized = JSON.stringify(activity);
        if (serialized === this.lastMessage && activitySerialized === this.lastActivity) return;
        message = serialized !== this.lastMessage ?
          { type: "decision", decision, ...(activity ? { activity } : {}) } : { type: "activity", activity };
      } catch (error) {
        if (!current()) return;
        this.onFault("Latest Decision decision could not be read");
        const activity = directory ? { unavailable: true, calls: null, skipped: null,
          message: "Saved activity could not be read for this thread." } : null;
        message = { type: "decision", decision: null, ...(activity ? { activity } : {}) };
        serialized = JSON.stringify(null);
        activitySerialized = JSON.stringify(activity);
      }
      if ((serialized !== this.lastMessage || activitySerialized !== this.lastActivity) && view.visible) {
        let delivered;
        try { delivered = await view.webview.postMessage(message); }
        catch { return; }
        if (delivered === false || !current()) return;
        this.lastMessage = serialized;
        this.lastActivity = activitySerialized;
        if (message.type === "activity") return;
        this.displayedDecision = message.decision;
        if (message.decision?.id !== undefined && message.decision.id !== this.lastDecisionId) {
          this.lastDecisionId = message.decision.id;
          this.nextDecisionAt = this.now() + MIN_DISPLAY_MS;
        } else if (!message.decision) {
          this.lastDecisionId = null;
          this.nextDecisionAt = 0;
        }
      }
    })();
    this.pending = task;
    try { return await task; } finally {
      this.pending = null;
      if (generation !== this.generation && this.view?.visible) void this.refresh();
    }
  }

  async setRawSkips(enabled) {
    let directory, rootDirectory;
    try { directory = this.dataDirectory(); rootDirectory = this.rootDataDirectory(); } catch { return; }
    if ((!directory && !rootDirectory) || !this.view?.visible) return;
    const view = this.view;
    if (this.rawTogglePending) {
      if (directory === this.rawToggle.directory && rootDirectory === this.rawToggle.rootDirectory &&
          view === this.rawToggle.view) this.rawToggle.enabled = enabled;
      return;
    }
    const toggle = { directory, rootDirectory, view, scope: this.generation, enabled };
    this.rawToggle = toggle;
    this.rawTogglePending = true;
    this.generation += 1;
    try {
      for (;;) {
        const desired = toggle.enabled;
        if (directory) await writeRawSkipPreference(directory, desired);
        if (rootDirectory && rootDirectory !== directory) await writeRawSkipPreference(rootDirectory, desired);
        if (toggle.enabled === desired) break;
      }
      this.rawCache = {};
    } catch {
      if (view === this.view) {
        try {
          await view.webview.postMessage({ type: "raw-skips-error",
            message: "Cannot save the skipped output setting." });
        } catch { /* The webview may have closed while saving. */ }
      }
    } finally {
      this.rawTogglePending = false;
      this.rawToggle = null;
      this.lastActivity = "";
      void this.refresh();
    }
  }

  dispose() { this.stop(); this.generation += 1; this.view = null; }
}

module.exports = { LatestDecisionProvider, VIEW_ID, MIN_DISPLAY_MS };
