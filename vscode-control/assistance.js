"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const client = require("./assistance-client");
const { parseUniqueJson } = require("./private-records");
const { readDeliveryReport } = require("./delivery-report");

function activateAssistance(vscode, context, { dataDirectory, sessionDirectory, sessionId,
  ready = null, resolveRuntime = client.runtime, send = client.request, register = client.registerMcp } = {}) {
  const controller = vscode.tests?.createTestController("codex-decision-failure-reviews", "Decision failure reviews");
  const ids = [];
  let disposed = false;
  const cancellations = new Set();
  if (controller) context.subscriptions.push(controller);
  context.subscriptions.push({ dispose() { disposed = true; for (const abort of cancellations) abort.abort(); } });
  const runtime = async () => {
    const installation = ready ? await ready() : null;
    return resolveRuntime(context.extensionUri.fsPath, dataDirectory(), { installation });
  };
  const show = async result => {
    if (disposed) return;
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(result, null, 2) });
    if (!disposed) await vscode.window.showTextDocument(document, { preview: true });
    return result;
  };
  const invoke = async payload => {
    const selectedSession = sessionId?.();
    const abort = new AbortController(); cancellations.add(abort);
    try { return await send(await runtime(), { ...payload, ...(selectedSession ? { session_id: selectedSession } : {}) }, { signal: abort.signal }); }
    finally { cancellations.delete(abort); }
  };
  const selected = () => {
    const editor = vscode.window.activeTextEditor;
    const text = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : "";
    if (!text.trim()) throw new Error("Select the evidence in an editor, or pass structured evidence to the Decision command");
    return text;
  };
  const command = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(`codexDecision.${name}`, async args => {
    try {
      if (disposed) return;
      return await handler(args);
    } catch (error) {
      if (!disposed) await vscode.window.showWarningMessage(error.message);
    }
  }));

  command("rankContext", async args => {
    let payload = args;
    if (!payload) {
      const text = selected();
      const query = await vscode.window.showInputBox({ title: "Decision context ranking", prompt: "Task or question to rank this evidence against" });
      if (!query?.trim()) return;
      payload = { query, candidates: [{ id: "selection", text }] };
    }
    return show(await invoke({ ...payload, workflow: "rank_context" }));
  });

  command("triageFailure", async args => {
    const failure = args?.failure || args || { name: path.basename(vscode.window.activeTextEditor?.document.fileName || "Selected failure"), output: selected() };
    if (typeof failure.name !== "string" || typeof failure.output !== "string") throw new Error("Provide a failure name and its original output");
    const result = await invoke({ workflow: "triage_failure", failure });
    if (controller && !disposed) {
      const id = crypto.randomUUID(), label = failure.name.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 160);
      const item = controller.createTestItem(id, label);
      const confidence = result.cause.confidence;
      item.description = `Advisory: ${confidence >= 0.5 ? result.cause.choice : "uncertain"}; priority ${result.priority.score.toFixed(2)}/2`;
      controller.items.add(item); ids.push(id);
      while (ids.length > 64) controller.items.delete(ids.shift());
      // Publish the supplied failure, never a model-generated pass/fail result.
      const run = controller.createTestRun(new vscode.TestRunRequest([item]), "Imported failure evidence", false);
      run.started(item);
      run.failed(item, new vscode.TestMessage(failure.output)); run.end();
    }
    return show(result);
  });

  command("verifyCompletion", async args => {
    const payload = args || parseUniqueJson(selected());
    return show(await invoke({ ...payload, workflow: "verify_completion" }));
  });
  command("showUsageMeasurements", async () => {
    const directory = sessionDirectory?.();
    if (!directory) throw new Error("Select a Codex chat before opening its usage measurements");
    return show(await readDeliveryReport(directory));
  });
  command("configureCompletionReview", async () => {
    const modes = [
      { label: "Off", description: "Do not retain or send completion evidence", mode: "off" },
      { label: "Observe", description: "Review bounded current-turn evidence; report unsupported claims", mode: "observe" },
      { label: "Enforce", description: "Continue once when evidence contradicts a completion claim", mode: "enforce" },
    ];
    const selected = await vscode.window.showQuickPick(modes, { title: "Decision completion verification" });
    if (!selected) return;
    await send(await runtime(), { version: 1, completion_verification: selected.mode }, { flag: "--assistance-settings" });
    await vscode.window.showInformationMessage(`Decision completion verification: ${selected.label}. Applies to enabled Decision sessions.`);
  });
  command("registerMcp", async () => {
    await register(await runtime());
    await vscode.window.showInformationMessage("Decision MCP registered in Codex configuration. Start a new Codex chat to load rank_context, triage_failure, and verify_completion.");
  });
  return { controller };
}

module.exports = { activateAssistance };
