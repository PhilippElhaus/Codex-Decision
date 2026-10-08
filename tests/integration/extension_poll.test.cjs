"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const core = require("../../vscode-control/core");
const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test("a status joining an earlier timer poll needs a subsequent read to observe metadata mutation",async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-coalesced-read-"));
  const sessionId = "synthetic", scoped = core.sessionDirectory(directory,sessionId);
  await core.ensureSessionDefaults(scoped);
  await fs.mkdir(path.join(scoped,"logs"));
  await fs.writeFile(path.join(scoped,"stats.json"),JSON.stringify({calls:2,completed:1,replaced:0,timed:2,elapsedMs:10}));
  await fs.writeFile(path.join(scoped,"logs/hook-health.json"),JSON.stringify({version:1,hook_version:"0.11.2",
    last_seen_ms:1,api_requests:6}));
  const commands = new Map(), timers = [], captured = deferred(), release = deferred();
  let holdNext = false, reads = 0;
  const originals = {load:Module._load,activity:core.readSessionActivity,health:core.checkHealth,
    interval:global.setInterval,clear:global.clearInterval};
  const fake = {window:{registerWebviewViewProvider:()=>({dispose(){}})},Uri:{joinPath:()=>({})},
    commands:{registerCommand(name,callback){commands.set(name,callback);return {dispose(){}};}},
    workspace:{getConfiguration:()=>({get:key=>key === "dataDirectory" ? directory : ""}),
      onDidChangeConfiguration:()=>({dispose(){}})}};
  const context = {subscriptions:[],extensionUri:{}};
  try {
    core.readSessionActivity = async (...args) => {
      reads += 1;
      const value = await originals.activity(...args);
      if (holdNext) {holdNext=false;captured.resolve();await release.promise;}
      return value;
    };
    core.checkHealth = async () => ({ok:false,reason:"DECISION_KEY_MISSING"});
    Module._load = function(request,parent,isMain) {return request === "vscode" ? fake : originals.load.call(this,request,parent,isMain);};
    delete require.cache[require.resolve("../../vscode-control/extension")];
    const extension = require("../../vscode-control/extension");
    Module._load = originals.load;
    global.setInterval = (callback,delay) => {const token={callback,delay};timers.push(token);return token;};
    global.clearInterval = () => {};
    extension.activate(context);
    const bridge = request=>commands.get("codexDecision.bridge")({action:"status",viewId:"synthetic-view",
      sourceId:"synthetic-source",sessionId,visible:true,focused:true,...request});
    assert.equal((await bridge()).stats.calls,6);
    holdNext = true;
    timers.find(timer=>timer.delay === 1000).callback();
    await captured.promise;
    const capturedReads = reads;
    await fs.writeFile(path.join(scoped,"stats.json"),'{"calls":"corrupt"}');
    const joined = Promise.all(Array.from({length:4},()=>bridge()));
    release.resolve();
    const replies = await joined;
    assert.equal(reads,capturedReads,"concurrent status requests share the already-open timer read");
    assert.ok(replies.every(reply=>reply.stats.calls === 6),"joined statuses return the snapshot captured before mutation");
    const current = await bridge();
    assert.equal(current.stats.calls,null,"a read begun after corruption cannot publish stale attempts");
    assert.equal(current.stats.completed,null);
    assert.equal(current.stats.estimatedTokensSaved,null);
    assert.equal(current.hookHealth.fault,"Hook status could not be read");
    await fs.writeFile(path.join(scoped,"stats.json"),JSON.stringify({calls:2,completed:1,replaced:0,timed:2,elapsedMs:10}));
    await bridge();
    const recovered = await bridge();
    assert.equal(recovered.stats.calls,6,"a new read after draining restores durable attempts");
    assert.equal(recovered.stats.completed,1);
    assert.equal(recovered.hookHealth.fault,undefined);
  } finally {
    release.resolve();
    for (const subscription of context.subscriptions) subscription.dispose?.();
    Module._load=originals.load;core.readSessionActivity=originals.activity;core.checkHealth=originals.health;
    global.setInterval=originals.interval;global.clearInterval=originals.clear;
    await fs.rm(directory,{recursive:true,force:true});
  }
});
