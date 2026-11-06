"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { decisionSummary, sessionDirectory, estimateTokensSaved, outcomeLine, readLifetimeStats, ensureSessionDefaults, readInstallationStats } = require("../../../vscode-control/core");

test("installation totals recompute estimates and preserve exact integer limits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-total-precision-"));
  try {
    for (const session of ["one", "two", "three"]) {
      const directory = sessionDirectory(root, session);
      await ensureSessionDefaults(directory);
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: 1, calls: 1, completed: 1, replaced: 1, timed: 1, elapsedMs: 10,
        savedChars: 2, candidates: 0, kept: 0, linesActuallyOmitted: 1, linesRelevanceJudged: 1,
      }));
    }
    let total = await readInstallationStats(root);
    assert.equal(total.savedChars, 6);
    assert.equal(total.estimatedTokensSaved, 2, "round the combined character estimate once");
    for (const session of ["one", "two"]) {
      const directory = sessionDirectory(root, session);
      await fs.writeFile(path.join(directory, "stats.json"), JSON.stringify({
        counter_scheme: 1, calls: Number.MAX_SAFE_INTEGER, completed: 1, replaced: 1,
        timed: 1, elapsedMs: Number.MAX_SAFE_INTEGER, savedChars: Number.MAX_SAFE_INTEGER,
        candidates: 0, kept: 0, linesActuallyOmitted: 1, linesRelevanceJudged: 1,
      }));
    }
    total = await readInstallationStats(root);
    for (const name of ["calls", "elapsedMs", "savedChars", "estimatedTokensSaved", "averageMs"]) {
      assert.equal(total[name], null, `${name} cannot silently return a rounded total`);
      assert.ok(total.overflowCounters.includes(name));
    }
    assert.equal(total.completed, 3, "unaffected exact counters remain available");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("aggregate reads stay bounded and await opened counter files before rejecting", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-counter-workers-"));
  const originalOpen = fs.open;
  let openHandles = 0, peakHandles = 0;
  const row = require("../../fixtures/activity-accounting.json").find(row => row.name === "current_exact");
  try {
    for (let index = 0; index < 20; index += 1) {
      const directory = sessionDirectory(root, `thread-${index}`);
      await fs.mkdir(path.join(directory,"logs"), {recursive:true,mode:0o700});
      await fs.writeFile(path.join(directory,"stats.json"),JSON.stringify(row.stats));
      await fs.writeFile(path.join(directory,"logs/hook-health.json"),JSON.stringify(row.health));
    }
    fs.open = async (filename,...args) => {
      const handle = await originalOpen(filename,...args);
      openHandles += 1; peakHandles = Math.max(peakHandles,openHandles);
      return {stat:()=>handle.stat(),read:(...readArgs)=>handle.read(...readArgs),close:async()=>{
        await new Promise(resolve=>setTimeout(resolve,2));
        try {await handle.close();} finally {openHandles -= 1;}
      }};
    };
    assert.equal((await readInstallationStats(root)).calls,120);
    assert.ok(peakHandles > 1 && peakHandles <= 8, `four workers open at most two metadata files each: ${peakHandles}`);
    assert.equal(openHandles,0);
    const selected = sessionDirectory(root,"thread-0");
    await fs.writeFile(path.join(selected,"logs/hook-health.json"),'{"version":"corrupt"}');
    await assert.rejects(readInstallationStats(root), /Invalid Decision hook health/);
    assert.equal(openHandles,0,"failed independent reads are joined and closed before returning");
  } finally {fs.open=originalOpen; await fs.rm(root,{recursive:true,force:true});}
});
