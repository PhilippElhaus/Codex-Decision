"use strict";

const vscode = require("vscode");
const { readLatestPanelDecision, readPanelActivity } = require("./panel-state");

const VIEW_ID = "codexDecisionDecision";
const MIN_SETTLED_MS = 1000;
// Match the line animation in webview/decision-panel.js before accepting a newer snapshot.
const BAR_FILL_MS = 900;
const PERCENT_FADE_MS = 180;
const MIN_DISPLAY_MS = BAR_FILL_MS + PERCENT_FADE_MS + MIN_SETTLED_MS;

class LatestDecisionProvider {
  constructor(extensionUri, dataDirectory, now = () => Date.now(), onFault = () => {}) {
    this.extensionUri = extensionUri;
    this.dataDirectory = dataDirectory;
    this.now = now;
    this.onFault = onFault;
    this.view = null;
    this.timer = null;
    this.pending = null;
    this.cache = {};
    this.lastMessage = "";
    this.lastActivity = "";
    this.displayedDecision = null;
    this.lastDecisionId = null;
    this.nextDecisionAt = 0;
    this.directory = undefined;
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
    if (!this.view?.visible || this.awaitingReady) return;
    let directory;
    let directoryFault = false;
    try { directory = this.dataDirectory(); }
    catch {
      directoryFault = true;
      directory = null;
    }
    if (directory !== this.directory) {
      this.directory = directory;
      this.generation += 1;
      this.cache = {};
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
      try { return directory === this.dataDirectory(); }
      catch { return directoryFault; }
    };
    const task = (async () => {
      let message;
      let serialized;
      let activitySerialized;
      try {
        if (directoryFault) throw new Error("Decision data directory is unavailable");
        const refreshDecision = this.now() >= this.nextDecisionAt;
        const [decision, activity] = await Promise.all([
          directory ? refreshDecision ? readLatestPanelDecision(directory, this.cache) : this.displayedDecision : null,
          directory ? readPanelActivity(directory) : null,
        ]);
        if (!current()) return;
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

  dispose() { this.stop(); this.generation += 1; this.view = null; }
}

module.exports = { LatestDecisionProvider, VIEW_ID, MIN_DISPLAY_MS };
