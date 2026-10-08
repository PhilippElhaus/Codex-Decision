"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const fixtures = require("../fixtures/average-ratios.json");
const core = require("../../vscode-control/core");

test("session and installation averages round exact safe integer ratios",async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"decision-exact-average-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory = core.sessionDirectory(root,"synthetic");
  await core.ensureSessionDefaults(directory);
  for (const row of fixtures) {
    if ([row.elapsed,row.timed].some(value=>BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))) continue;
    const stats = {counter_scheme:1,calls:0,completed:0,replaced:0,timed:Number(row.timed),elapsedMs:Number(row.elapsed)};
    await fs.writeFile(path.join(directory,"stats.json"),JSON.stringify(stats));
    assert.equal((await core.readLifetimeStats(directory)).averageMs,Number(row.expected),JSON.stringify(row));
    assert.equal((await core.readSessionActivity(directory)).averageMs,Number(row.expected),JSON.stringify(row));
    assert.equal((await core.readInstallationStats(root)).averageMs,Number(row.expected),JSON.stringify(row));
    await fs.writeFile(path.join(directory,"stats.json"),JSON.stringify({...stats,partial_timed:1}));
    assert.equal((await core.readSessionActivity(directory)).averageMs,null);
    assert.equal((await core.readInstallationStats(root)).averageMs,null);
  }
});
