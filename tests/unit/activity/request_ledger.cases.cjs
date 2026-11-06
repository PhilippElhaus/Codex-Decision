"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readHookHealth, readSessionActivity, readRecentOutcomes } = require("../../../vscode-control/core");

test("a torn exact request ledger is re-read once without inventing attempts from legacy totals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-stage-consistency-"));
  const statsFile=path.join(directory,"stats.json"),healthFile=path.join(directory,"logs/hook-health.json");
  const fixture=require("../../fixtures/activity-accounting.json").find(row=>row.name==="current_exact");
  const oldHealth={...fixture.health,api_requests:6,responses_received:4,responses_validated:3,request_failures:1,request_cancelled:2};
  const newHealth={...oldHealth,api_requests:11,responses_received:9,responses_validated:8};
  const newStats={...fixture.stats,calls:8,timed:8,elapsedMs:800,completed:4};
  const originalOpen=fs.open;
  let releaseStats,healthOpens=0;
  const barrier=new Promise(resolve=>{releaseStats=resolve;});
  try {
    await fs.mkdir(path.dirname(healthFile));
    await fs.writeFile(statsFile,JSON.stringify({...fixture.stats,calls:3}));
    await fs.writeFile(healthFile,JSON.stringify(oldHealth));
    fs.open=async(filename,...args)=>{
      if(filename===statsFile) await barrier;
      const handle=await originalOpen(filename,...args);
      if(filename!==healthFile) return handle;
      const number=++healthOpens;
      return {stat:()=>handle.stat(),read:(...readArgs)=>handle.read(...readArgs),close:async()=>{
        await handle.close();
        if(number===1) {
          await fs.writeFile(`${healthFile}.next`,JSON.stringify(newHealth));await fs.rename(`${healthFile}.next`,healthFile);
          await fs.writeFile(`${statsFile}.next`,JSON.stringify(newStats));await fs.rename(`${statsFile}.next`,statsFile);
          releaseStats();
        }
      }};
    };
    const consistent=await readSessionActivity(directory);
    assert.equal(healthOpens,2,"an older health record cannot contradict disjoint terminal outcomes");
    assert.equal(consistent.calls,11);assert.equal(consistent.responsesValidated,8);
    assert.deepEqual(consistent.partialCounters,[]);
    fs.open=originalOpen;
    await fs.writeFile(healthFile,JSON.stringify(oldHealth));
    healthOpens=0;
    fs.open=async(filename,...args)=>{if(filename===healthFile) healthOpens+=1;return originalOpen(filename,...args);};
    await assert.rejects(readSessionActivity(directory),/Inconsistent Decision activity counters/);
    assert.equal(healthOpens,2,"persistent inconsistency becomes unavailable after one bounded retry");
    await fs.writeFile(healthFile,JSON.stringify({...oldHealth,hook_version:"0.11.4"}));
    healthOpens=0;
    await assert.rejects(readSessionActivity(directory),/Inconsistent Decision activity counters/);
    assert.equal(healthOpens,2,"an old writer's exact attempts still cannot lag known completions");
    const legacy={...oldHealth};delete legacy.counter_scheme;delete legacy.partial_counters;
    await fs.writeFile(healthFile,JSON.stringify(legacy));
    healthOpens=0;
    const partial=await readSessionActivity(directory);
    assert.equal(healthOpens,1);
    assert.equal(partial.calls,8,"uncertain legacy counters are not summed into invented historical attempts");
    assert.ok(partial.partialCounters.includes("calls"));
  } finally {releaseStats();fs.open=originalOpen;await fs.rm(directory,{recursive:true,force:true});}
});
