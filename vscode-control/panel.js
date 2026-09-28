"use strict";

const vscode = require("vscode");
const { readLatestPanelDecision } = require("./panel-state");

const VIEW_ID = "codexJevDecision";

class LatestDecisionProvider {
  constructor(extensionUri, dataDirectory) {
    this.extensionUri = extensionUri;
    this.dataDirectory = dataDirectory;
    this.view = null;
    this.timer = null;
    this.pending = null;
    this.lastMessage = "";
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
  }

  async refresh() {
    if (!this.view?.visible) return;
    if (this.pending) return this.pending;
    const task = (async () => {
      let message;
      try {
        const directory = this.dataDirectory();
        const decision = await readLatestPanelDecision(directory);
        message = { type: "decision", decision };
      } catch (error) {
        message = { type: "decision", decision: null,
          error: /dataDirectory/.test(error.message) ? "Set the Jev data directory in VS Code settings." :
            "The latest Jev decision could not be read." };
      }
      const serialized = JSON.stringify(message);
      if (serialized !== this.lastMessage && this.view?.visible) {
        this.lastMessage = serialized;
        await this.view.webview.postMessage(message);
      }
    })();
    this.pending = task;
    try { return await task; } finally { this.pending = null; }
  }

  dispose() { this.stop(); }
}

module.exports = { LatestDecisionProvider, VIEW_ID };
