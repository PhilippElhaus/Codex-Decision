"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parsePanelDecision, readLatestPanelDecision } = require("../../vscode-control/panel-state");

const snapshot = { id: "a".repeat(32), at: "2026-09-28T12:34:56.123456+00:00" };

test("validated formats count actual requests while older classified panels stay readable", () => {
  const current = { version: 6, ...snapshot, receipt_id: "b".repeat(32), filter: "output", status: "replace",
    batch: { number: 1, count: 1, target_count: 1 }, batch_elapsed_ms: 30,
    rows: [{ line: 1, excerpt: "routine", action: "omit", reason: "irrelevant", task_relevant: .03 }],
    totals: { seen: 1, judged: 1, kept: 0, omitted: 1, protected: 0, unjudged: 0, requests: 1, classification_requests: 0 } };
  assert.equal(parsePanelDecision(current).totals.requests, 1);
  assert.equal(parsePanelDecision({ ...current, totals: { ...current.totals, requests: 2, classification_requests: 1 } }).totals.requests, 2);
  assert.throws(() => parsePanelDecision({ ...current, totals: { ...current.totals, requests: 2 } }));
  assert.throws(() => parsePanelDecision({ ...current, totals: { ...current.totals, requests: 3, classification_requests: 2 } }));
});

test("complete panels include all 72 lines and the three protected keeps without invented scores", () => {
  const rows = Array.from({ length: 72 }, (_, index) => index < 69 ? {
    line: index + 1, excerpt: "routine", action: "omit", reason: "irrelevant", task_relevant: .03,
  } : { line: index + 1, excerpt: "protected diagnostic or completion", action: "keep",
    reason: "protected", protected_reason: "diagnostic_context", task_relevant: null });
  const current = { version: 5, ...snapshot, receipt_id: "b".repeat(32), filter: "output", status: "candidate",
    batch: { number: 1, count: 1, target_count: 69 }, batch_elapsed_ms: 30, rows,
    totals: { seen: 72, judged: 69, kept: 3, omitted: 69, protected: 3, unjudged: 0, requests: 2 } };
  const parsed = parsePanelDecision(current);
  assert.equal(parsed.rows.length, 72);
  assert.equal(parsed.rows.filter(row => row.action === "keep").length, 3);
  assert.ok(parsed.rows.slice(69).every(row => row.retention_index === null && row.task_relevant === null));
  assert.throws(() => parsePanelDecision({ ...current, rows: rows.slice(0, 69) }));
  assert.throws(() => parsePanelDecision({ ...current, rows: rows.map(row => row.line === 72 ? { ...row, action: "omit" } : row) }));
  assert.throws(() => parsePanelDecision({ ...current, totals: { ...current.totals, protected: 2 } }));
});

test("complete progress panels show prior batches and pending lines in source order", () => {
  const rows = Array.from({ length: 1600 }, (_, index) => ({ line: index + 1, excerpt: "routine",
    action: index < 800 ? "omit" : "keep", reason: index < 800 ? "irrelevant" : "budget_unjudged",
    task_relevant: index < 800 ? .03 : null }));
  const current = { version: 5, ...snapshot, receipt_id: "b".repeat(32), filter: "output", status: "processing",
    batch: { number: 2, count: 5, target_count: 400 }, batch_elapsed_ms: 30, rows,
    totals: { seen: 1600, judged: 800, kept: 800, omitted: 800, protected: 0, unjudged: 800, requests: 3 } };
  const parsed = parsePanelDecision(current);
  assert.equal(parsed.rows.length, 1600);
  assert.equal(parsed.rows[1599].retention_index, null);
  assert.equal(parsed.rows[0].retention_index, .03);
});

test("current relevance snapshots use real Nouls and count both serial requests", () => {
  const current = { version: 4, ...snapshot, receipt_id: "b".repeat(32), filter: "output", status: "replace",
    batch: {number:1,count:1,target_count:2},batch_elapsed_ms:30,
    rows:[{line:1,excerpt:"routine",action:"omit",reason:"irrelevant",task_relevant:.03},
      {line:2,excerpt:"needed",action:"keep",reason:"task_relevant",task_relevant:.95}],
    totals:{seen:3,judged:2,kept:2,omitted:1,protected:1,unjudged:0,requests:2}};
  const parsed=parsePanelDecision(current);
  assert.equal(parsed.rows[0].retention_index,.03);
  assert.equal(parsed.rows[1].retention_index,.95);
  assert.equal(parsed.rows[0].can_omit,null);
  assert.throws(()=>parsePanelDecision({...current,totals:{...current.totals,requests:1}}));
  assert.throws(()=>parsePanelDecision({...current,rows:current.rows.map(row=>({...row,can_omit:.99}))}));
  assert.throws(()=>parsePanelDecision({...current,rows:[{...current.rows[0],task_relevant:1.1},current.rows[1]]}));
  assert.throws(()=>parsePanelDecision({...current,totals:{...current.totals,protected:4}}));
  assert.throws(()=>parsePanelDecision({...current,totals:{...current.totals,unjudged:4}}));
  assert.throws(()=>parsePanelDecision({...current,rows:[current.rows[0],{...current.rows[1],line:4}]}));
});

test("current panels accept multiple relevance batches and more than 250 targets", () => {
  const rows = Array.from({length:400},(_,index)=>({line:index+1,excerpt:"routine",
    action:"omit",reason:"irrelevant",task_relevant:.03}));
  const current = {version:4,...snapshot,receipt_id:"b".repeat(32),filter:"output",status:"processing",
    batch:{number:2,count:5,target_count:400},batch_elapsed_ms:30,rows,
    totals:{seen:1600,judged:800,kept:800,omitted:800,protected:0,unjudged:800,requests:3}};
  assert.equal(parsePanelDecision(current).rows.length,400);
  assert.equal(parsePanelDecision(current).batch.count,5);
  assert.throws(()=>parsePanelDecision({...current,totals:{...current.totals,requests:2}}));
  assert.throws(()=>parsePanelDecision({...current,batch:{...current.batch,number:6}}));
});

test("panel reads the current snapshot and rejects linked files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-panel-test-"));
  try {
    assert.equal(await readLatestPanelDecision(directory), null);
    const logs = path.join(directory, "logs");
    await fs.mkdir(logs);
    const filename = path.join(logs, "latest-decision.json");
    await fs.writeFile(filename, JSON.stringify({ version: 2 }));
    await assert.rejects(readLatestPanelDecision(directory), /Unsupported Jev panel decision/);
    const rows = Array.from({ length: 250 }, (_, index) => ({ line: index + 1,
      excerpt: `Synthetic source line ${index + 1} ${"x".repeat(90)}`, action: "keep",
      reason: "below_omit_cutoff", can_omit: 0.3, exact_needed: 0.2, task_relevant: null }));
    const version3 = { version: 3, id: snapshot.id, receipt_id: "b".repeat(32),
      at: snapshot.at, filter: "search_listing", status: "keep",
      batch: { number: 1, count: 1, target_count: 250 }, rows,
      totals: { seen: 250, judged: 250, kept: 250, omitted: 0, protected: 0, unjudged: 0, requests: 1 },
      batch_elapsed_ms: 48 };
    assert.ok(Buffer.byteLength(JSON.stringify(version3)) > 16_384);
    await fs.writeFile(filename, JSON.stringify(version3));
    assert.equal((await readLatestPanelDecision(directory)).rows.length, 250);
    const mixed = { ...version3, batch: { ...version3.batch, target_count: 3 },
      rows: [
        { ...rows[0], can_omit: .98, exact_needed: .94, reason: "exact_text" },
        { ...rows[1], can_omit: .98, exact_needed: .02, task_relevant: .96, reason: "task_relevant" },
        { ...rows[2], action: "omit", can_omit: .98, exact_needed: .02,
          task_relevant: .03, reason: "confident_omission" },
      ], totals: { ...version3.totals, kept: 249, omitted: 1 } };
    const [exact, relevant, cut] = parsePanelDecision(mixed).rows;
    assert.ok(exact.retention_index > .95);
    assert.ok(relevant.retention_index > .95);
    assert.ok(cut.retention_index < .05);
    assert.equal(parsePanelDecision({ ...version3,
      batch: { ...version3.batch, number: 13, count: 20 },
      totals: { ...version3.totals, requests: 13 } }).batch.number, 13);
    assert.throws(() => parsePanelDecision({ ...version3, rows: [...rows, rows[0]],
      batch: { ...version3.batch, target_count: 251 } }), /batch decision/);
    assert.throws(() => parsePanelDecision({ ...version3, rows: rows.map((row, index) =>
      index === 0 ? { ...row, can_omit: 1.2 } : row) }), /probability/);
    assert.throws(() => parsePanelDecision({ ...version3, rows: rows.map((row, index) =>
      index === 1 ? { ...row, line: 1 } : row) }), /batch row/);
    await fs.rename(filename, path.join(directory, "owned.json"));
    await t.test("linked snapshot files are rejected", async (t) => {
      try {
        await fs.symlink(path.join(directory, "owned.json"), filename);
      } catch (error) {
        if (process.platform !== "win32" || error.code !== "EPERM") throw error;
        t.skip("Windows file symlinks require Developer Mode or elevation");
        return;
      }
      await assert.rejects(readLatestPanelDecision(directory), /Unsafe/);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("panel snapshot reads remain bounded when a file grows after stat", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jev-panel-growth-"));
  const filename = path.join(directory, "logs", "latest-decision.json");
  const originalOpen = fs.open;
  let bytesRequested = 0;
  let closed = false;
  try {
    await fs.mkdir(path.dirname(filename));
    await fs.writeFile(filename, "{}");
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      return {
        stat: () => handle.stat(),
        async read(buffer, offset, length) {
          bytesRequested += length;
          buffer.fill(32, offset, offset + length);
          return { bytesRead: length };
        },
        async close() { closed = true; await handle.close(); },
      };
    };
    await assert.rejects(readLatestPanelDecision(directory), /Unsafe Jev panel decision file/);
    assert.equal(bytesRequested, 8 * 1024 * 1024 + 1);
    assert.equal(closed, true);
  } finally {
    fs.open = originalOpen;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
