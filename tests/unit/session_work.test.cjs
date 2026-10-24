"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readSessionWorkComplete, sessionWorkDirectory } = require("../../vscode-control/session-work");

const session = "11111111-1111-4111-8111-111111111111";
const event = type => ({ type: "event_msg", payload: { type } });
const records = (...items) => items.map(item => JSON.stringify(item) + "\n").join("");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-session-work-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const day = path.join(root, "2026", "10", "21");
  await fs.mkdir(day, { recursive: true });
  const filename = path.join(day, `rollout-2026-10-21T10-00-00-${session}.jsonl`);
  return { root, day, filename, read: () => readSessionWorkComplete(session, { sessionsDirectory: root }) };
}

test("session completion follows only the latest reliable turn signal", async t => {
  const { filename, read } = await fixture(t);
  assert.equal(await read(), false);
  await fs.writeFile(filename, records(event("task_started")));
  assert.equal(await read(), false);
  await fs.appendFile(filename, records(event("task_complete"), event("token_count")));
  assert.equal(await read(), true);
  await fs.appendFile(filename, records(event("task_started")));
  assert.equal(await read(), false);
  await fs.appendFile(filename, records(event("task_complete")));
  assert.equal(await read(), true);
  await fs.appendFile(filename, records({ type: "turn_context", payload: {} }));
  assert.equal(await read(), false);
});

test("user input, tool calls, aborted turns, and partial rows cannot flush the queue", async t => {
  const { filename, read } = await fixture(t);
  for (const activity of [event("user_message"), event("turn_aborted"),
    { type: "response_item", payload: { type: "custom_tool_call" } },
    { type: "response_item", payload: { type: "message", role: "user" } }]) {
    await fs.writeFile(filename, records(event("task_complete"), activity));
    assert.equal(await read(), false);
  }
  await fs.writeFile(filename, records(event("task_complete")) + '{"type":"event_msg"');
  assert.equal(await read(), false);
  await fs.writeFile(filename, records(event("task_complete")) + "bad-json\n");
  assert.equal(await read(), false);
});

test("session filenames own completion even when inherited metadata names another session", async t => {
  const { root, day, filename, read } = await fixture(t);
  const other = "22222222-2222-4222-8222-222222222222";
  await fs.writeFile(path.join(day, `rollout-2026-10-21T10-00-00-${other}.jsonl`),
    records({ type: "session_meta", payload: { id: session } }, event("task_complete")));
  assert.equal(await read(), false);
  await fs.writeFile(filename,
    records({ type: "session_meta", payload: { id: other } }, event("task_complete")));
  assert.equal(await read(), true);
  assert.equal(await readSessionWorkComplete("../" + session, { sessionsDirectory: root }), false);
  assert.equal(await readSessionWorkComplete(null, { sessionsDirectory: root }), false);
});

test("completion reads a bounded tail and rejects linked paths", async t => {
  const { root, filename, read } = await fixture(t);
  await fs.writeFile(filename, records({ type: "response_item", payload: { output: "x".repeat(300_000) } },
    event("task_complete")));
  assert.equal(await read(), true);
  await fs.writeFile(filename, records(event("task_complete"),
    { type: "response_item", payload: { output: "x".repeat(300_000) } }));
  assert.equal(await read(), false, "an old completion outside the tail stays unknown");
  const target = path.join(root, "target.jsonl");
  await fs.writeFile(target, records(event("task_complete")));
  await fs.unlink(filename);
  try { await fs.symlink(target, filename); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.diagnostic("File links unavailable"); return; } throw error; }
  assert.equal(await read(), false);
  const linkedRoot = path.join(root, "linked-sessions");
  await fs.symlink(path.dirname(filename), linkedRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await readSessionWorkComplete(session, { sessionsDirectory: linkedRoot }), false);
});

test("session directory resolution supports Linux, custom Codex homes, and WSL UNC paths", () => {
  const linux = { platform: "linux", home: "/home/alex", codexHome: "" };
  assert.equal(sessionWorkDirectory(linux), "/home/alex/.codex/sessions");
  assert.equal(sessionWorkDirectory({ ...linux, codexHome: "/custom/codex" }), "/custom/codex/sessions");
  assert.equal(sessionWorkDirectory({ ...linux, dataDirectory: "/custom/codex/plugins/data/decision-personal" }),
    "/custom/codex/sessions");
  const windows = { platform: "win32", home: "C:\\Users\\Alex", codexHome: "",
    dataDirectory: "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\plugins\\data\\decision-personal" };
  assert.equal(sessionWorkDirectory(windows), "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\sessions");
  assert.equal(sessionWorkDirectory({ ...windows, codexHome: "/custom/codex" }),
    "\\\\wsl.localhost\\Ubuntu\\custom\\codex\\sessions");
  assert.equal(sessionWorkDirectory({ ...windows, dataDirectory: "\\\\wsl$\\Ubuntu\\home\\alex\\private-data" }),
    "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\sessions");
  assert.equal(sessionWorkDirectory({ ...windows, dataDirectory: "", codexHome: "C:\\Codex" }), "C:\\Codex\\sessions");
});

test("session directories ignore CODEX_HOME inherited from the other runtime", () => {
  const native = { platform: "win32", home: "C:\\Users\\Alex",
    dataDirectory: "C:\\Users\\Alex\\.codex\\plugins\\data\\decision-personal" };
  for (const codexHome of ["/home/alex/.codex", "\\\\wsl$\\Ubuntu\\home\\alex\\.codex"]) {
    assert.equal(sessionWorkDirectory({ ...native, codexHome }), "C:\\Users\\Alex\\.codex\\sessions");
  }
  const wsl = { ...native,
    dataDirectory: "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\plugins\\data\\decision-personal" };
  for (const codexHome of ["C:\\Users\\Alex\\.codex", "\\\\wsl$\\Other\\home\\alex\\.codex"]) {
    assert.equal(sessionWorkDirectory({ ...wsl, codexHome }), "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\sessions");
  }
});
