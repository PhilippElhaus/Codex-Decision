"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readRawSkipState, writeRawSkipPreference, parseRawSkips, MAX_RAW_BYTES,
  MAX_PAYLOAD_BYTES } = require("../../vscode-control/raw-skip-state");

const entry = () => ({ id: "a".repeat(32), at: "2026-10-20T10:00:00Z", reason: "small", detail: null,
  tool_name: "exec_command", tool_use_id: "synthetic-call", payload_unavailable: null,
  payload: { tool_input_json: '{"cmd":"printf synthetic", "large_integer":18446744073709551615}',
    tool_response_json: '"synthetic output\\n"' } });

test("raw metadata bounds count Unicode scalar values like the Rust capture writer", () => {
  const unicode = { ...entry(), tool_name: "𐐀".repeat(256), tool_use_id: "𐐀".repeat(128) };
  assert.equal(parseRawSkips({ version: 1, entries: [unicode] })[0].tool_name, unicode.tool_name);
  assert.throws(() => parseRawSkips({ version: 1, entries: [{ ...unicode, tool_name: unicode.tool_name + "𐐀" }] }), /Invalid/);
  assert.throws(() => parseRawSkips({ version: 1, entries: [{ ...unicode, tool_use_id: unicode.tool_use_id + "𐐀" }] }), /Invalid/);
});

test("raw capture is opt-in, private, per-thread, and does not read retained payloads when disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-raw-state-"));
  const directory = path.join(root, "sessions", "a".repeat(64));
  try {
    assert.deepEqual(await readRawSkipState(directory), { enabled: false, entries: [] });
    await writeRawSkipPreference(directory, true);
    assert.deepEqual(await readRawSkipState(directory), { enabled: true, entries: [] });
    const filename = path.join(directory, "logs", "skipped-raw.json");
    await fs.writeFile(filename, JSON.stringify({ version: 1, entries: [entry()] }), { mode: 0o600 });
    const state = await readRawSkipState(directory, {});
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].payload.tool_input_json, entry().payload.tool_input_json,
      "JSON tokens beyond JavaScript's exact integer range remain unchanged");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.join(directory, "logs"))).mode & 0o077, 0);
      assert.equal((await fs.stat(path.join(directory, "logs", "skipped-raw-enabled.json"))).mode & 0o077, 0);
    }
    await writeRawSkipPreference(directory, false);
    await fs.writeFile(filename, "{broken");
    assert.deepEqual(await readRawSkipState(directory), { enabled: false, entries: [] });
    assert.deepEqual(await readRawSkipState(path.join(root, "sessions", "b".repeat(64))), { enabled: false, entries: [] });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("raw reader rejects oversized, linked, duplicate and malformed local records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "decision-raw-invalid-"));
  try {
    await writeRawSkipPreference(directory, true);
    const filename = path.join(directory, "logs", "skipped-raw.json");
    await fs.writeFile(filename, Buffer.alloc(MAX_RAW_BYTES + 1), { mode: 0o600 });
    await assert.rejects(readRawSkipState(directory), /Unsafe/);
    await fs.writeFile(filename, '{"version":1,"version":1,"entries":[]}');
    await assert.rejects(readRawSkipState(directory), /Duplicate/);
    await fs.writeFile(filename, JSON.stringify({ version: 1, entries: [{ ...entry(), reason: "unsafe reason" }] }));
    await assert.rejects(readRawSkipState(directory), /Invalid/);
    if (process.platform !== "win32") {
      const owned = path.join(directory, "owned.json");
      await fs.rename(filename, owned);
      await fs.symlink(owned, filename);
      await assert.rejects(readRawSkipState(directory), /Unsafe/);
      await fs.unlink(filename);
      const flag = path.join(directory, "logs", "skipped-raw-enabled.json");
      await fs.rename(flag, path.join(directory, "flag.json"));
      await fs.symlink(path.join(directory, "flag.json"), flag);
      await assert.rejects(writeRawSkipPreference(directory, false), /Unsafe/);
    }
    assert.throws(() => parseRawSkips({ version: 1, entries: Array.from({ length: 21 }, entry) }), /Invalid/);
    assert.throws(() => parseRawSkips({ version: 1, entries: [{ ...entry(), payload: {
      tool_input_json: "x".repeat(MAX_PAYLOAD_BYTES), tool_response_json: "null" } }] }), /Invalid/);
    const unavailable = { ...entry(), payload: null, payload_unavailable: "size_limit" };
    assert.equal(parseRawSkips({ version: 1, entries: [unavailable] })[0].payload, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
