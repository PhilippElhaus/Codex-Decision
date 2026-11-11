"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { activateAssistance } = require("../../vscode-control/assistance");

function fixture() {
  const commands = new Map(), items = new Map(), results = [], messages = [], documents = [];
  items.add = item => items.set(item.id, item);
  const controller = { items, dispose() {}, createTestItem: (id, label) => ({ id, label }),
    createTestRun: (_request, name, persist) => ({ started() {}, failed(item, message) { results.push({ item, message, name, persist }); }, end() {} }) };
  const vscode = {
    tests: { createTestController: () => controller },
    TestRunRequest: class { constructor(items) { this.include = items; } }, TestMessage: class { constructor(message) { this.message = message; } },
    commands: { registerCommand(name, handler) { commands.set(name, handler); return { dispose() {} }; } },
    window: { showTextDocument: async () => {}, showWarningMessage: async message => messages.push(message),
      showInformationMessage: async message => messages.push(message), showQuickPick: async items => items[1] },
    workspace: { openTextDocument: async document => { documents.push(document); return document; } },
  };
  return { vscode, context: { subscriptions: [], extensionUri: { fsPath: "/extension" } }, commands, items, results, messages, documents };
}

test("failure review publishes supplied failures and keeps uncertain model advice separate", async () => {
  const f = fixture(), calls = [];
  activateAssistance(f.vscode, f.context, { dataDirectory: () => "/data", sessionId: () => "selected-thread",
    resolveRuntime: async () => ({}), send: async (_runtime, payload) => {
      calls.push(payload); return { workflow: "triage_failure", advisory: true,
        cause: { choice: "application", confidence: 0.3 }, priority: { score: 1.5 } };
    } });
  const original = "assertion failed: left 1, right 2";
  const result = await f.commands.get("codexDecision.triageFailure")({ name: "native case", output: original });
  assert.equal(result.advisory, true);
  assert.equal(calls[0].session_id, "selected-thread");
  assert.equal(f.results[0].message.message, original);
  assert.equal(f.results[0].persist, false);
  assert.match(f.results[0].item.description, /uncertain/);
  assert.equal(f.documents.length, 1);
  for (const item of f.context.subscriptions) item.dispose();
});

test("all assistance commands use the native service and never activate registration during startup", async () => {
  const f = fixture(), calls = [];
  let registrations = 0;
  activateAssistance(f.vscode, f.context, { dataDirectory: () => "/data", resolveRuntime: async () => ({}),
    register: async () => { registrations++; }, send: async (_runtime, payload, options) => {
      calls.push({ payload, options }); return { advisory: true, candidates: payload.candidates };
    } });
  assert.equal(registrations, 0);
  const candidates = [{ id: "source", text: "Exact Unicode λ source" }];
  const result = await f.commands.get("codexDecision.rankContext")({ query: "task", candidates });
  assert.deepEqual(result.candidates, candidates);
  await f.commands.get("codexDecision.configureCompletionReview")();
  assert.equal(calls[1].options.flag, "--assistance-settings");
  assert.equal(calls[1].payload.completion_verification, "observe");
  await f.commands.get("codexDecision.registerMcp")();
  assert.equal(registrations, 1);
  for (const item of f.context.subscriptions) item.dispose();
  assert.equal(await f.commands.get("codexDecision.rankContext")({ query: "task", candidates }), undefined);
});
