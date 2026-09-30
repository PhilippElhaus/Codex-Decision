"use strict";

const vscode = require("vscode");
const { readLatestPanelDecision } = require("./panel-state");

const VIEW_ID = "codexJevDecision";
const MIN_SETTLED_MS = 1000;
// Match the line animation in webview/jev-panel.js before accepting a newer snapshot.
const BAR_FILL_MS = 900;
const PERCENT_FADE_MS = 180;
const MIN_DISPLAY_MS = BAR_FILL_MS + PERCENT_FADE_MS + MIN_SETTLED_MS;

class LatestDecisionProvider {
  constructor(extensionUri, dataDirectory, now = () => Date.now(), onFault = () => {}) {
    this.extensionUri = extensionUri;
    this.dataDirectory = dataDirectory;
    this.now = now;
    this.onFault = onFault;
    this.startedAt = now();
    this.view = null;
    this.timer = null;
    this.pending = null;
    this.lastMessage = "";
    this.lastDecisionId = null;
    this.nextDecisionAt = 0;
  }

  resolveWebviewView(view) {
    this.view = view;
    this.lastMessage = "";
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview")] };
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "jev-panel.css"));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "webview", "jev-panel.js"));
    webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};"><link rel="stylesheet" href="${style}"></head><body><main id="app" aria-live="polite"></main><script src="${script}"></script></body></html>`;
    const ready = webview.onDidReceiveMessage((message) => {
      if (message?.type === "ready") {
        this.lastMessage = "";
        this.lastDecisionId = null;
        this.nextDecisionAt = 0;
        void this.refresh();
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) this.start();
      else this.stop();
    });
    view.onDidDispose(() => {
      this.stop();
      ready.dispose();
      visibility.dispose();
      if (this.view === view) this.view = null;
    });
    if (view.visible) this.start();
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => { void this.refresh(); }, 500);
    void this.refresh();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextDecisionAt = 0;
  }

  async refresh() {
    if (!this.view?.visible) return;
    if (this.now() < this.nextDecisionAt) return;
    if (this.pending) return this.pending;
    const task = (async () => {
      let message;
      try {
        const directory = this.dataDirectory();
        const decision = directory ? await readLatestPanelDecision(directory) : null;
        this.onFault(null);
        message = { type: "decision", decision: decision && Date.parse(decision.at) >= this.startedAt ? decision : null };
      } catch (error) {
        this.onFault("Latest Jev decision could not be read");
        message = { type: "decision", decision: null };
      }
      const serialized = JSON.stringify(message);
      if (serialized !== this.lastMessage && this.view?.visible) {
        this.lastMessage = serialized;
        if (message.decision?.id !== undefined && message.decision.id !== this.lastDecisionId) {
          this.lastDecisionId = message.decision.id;
          this.nextDecisionAt = this.now() + MIN_DISPLAY_MS;
        } else if (!message.decision) {
          this.lastDecisionId = null;
          this.nextDecisionAt = 0;
        }
        await this.view.webview.postMessage(message);
      }
    })();
    this.pending = task;
    try { return await task; } finally { this.pending = null; }
  }

  dispose() { this.stop(); }
}

module.exports = { LatestDecisionProvider, VIEW_ID, MIN_DISPLAY_MS };
