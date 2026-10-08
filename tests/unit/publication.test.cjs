"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const fixture = require("../fixtures/publication-case.json");
const core = require("../../vscode-control/core");
const { readLatestPanelDecision } = require("../../vscode-control/panel-state");
const { validateJournal } = require("../../vscode-control/publication-journal");
const { parseUniqueJson, parseUnsignedJson } = require("../../vscode-control/private-records");

async function create(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-publication-reader-"));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,"logs"),{mode:0o700});
  const write = (name,bytes) => fs.writeFile(path.join(directory,name),bytes,{mode:0o600});
  const journal = state => write("logs/.decision-publication.json",JSON.stringify({...fixture.prepared,state}));
  await write("stats.json",fixture.stats_after);
  await write("logs/latest-decision.json",fixture.snapshot_after);
  await write(`logs/.decision-publication-${fixture.prepared.receipt_id}.snapshot-before`,fixture.snapshot_before);
  await write("logs/events.jsonl",fixture.events_before+fixture.event);
  await journal("prepared");
  return {directory,write,journal};
}

test("prepared publication hides new totals, snapshot and history until the commit marker",async t => {
  const {directory,journal} = await create(t);
  assert.equal((await core.readLifetimeStats(directory)).completed,1);
  assert.equal((await core.readSessionActivity(directory)).completed,1);
  assert.equal((await readLatestPanelDecision(directory)).status,"processing");
  assert.deepEqual((await core.readRecentOutcomes(directory)).map(row=>row.status),["keep"]);
  const cursor = await core.readEventCursor(directory);
  assert.equal(cursor.offset,Buffer.byteLength(fixture.events_before));
  assert.deepEqual((await core.readEventsSince(directory,cursor)).events,[]);
  await journal("committed");
  assert.equal((await core.readLifetimeStats(directory)).completed,2);
  assert.equal((await readLatestPanelDecision(directory)).status,"replace");
  assert.deepEqual((await core.readRecentOutcomes(directory)).map(row=>row.status),["replace","keep"]);
  assert.deepEqual((await core.readEventsSince(directory,cursor)).events.map(row=>row.status),["replace"]);
});

test("pending preimages need no backup and committed postimages need no prior backup",async t => {
  const {directory,write,journal} = await create(t);
  await fs.rm(path.join(directory,`logs/.decision-publication-${fixture.prepared.receipt_id}.snapshot-before`));
  await write("logs/latest-decision.json",fixture.snapshot_before);
  assert.equal((await readLatestPanelDecision(directory)).status,"processing");
  await write("logs/latest-decision.json",fixture.snapshot_after);
  await assert.rejects(readLatestPanelDecision(directory),/backup changed/);
  await journal("committed");
  assert.equal((await readLatestPanelDecision(directory)).status,"replace");
});

test("unknown pending images and external event appends are refused without mutation",async t => {
  const {directory,write} = await create(t);
  const mutated = JSON.stringify({calls:99,completed:99});
  await write("stats.json",mutated);
  await assert.rejects(core.readLifetimeStats(directory),/image changed/);
  assert.equal(await fs.readFile(path.join(directory,"stats.json"),"utf8"),mutated);
  await write("stats.json",fixture.stats_after);
  await write("logs/events.jsonl",fixture.events_before+fixture.event+'{"status":"keep"}\n');
  await assert.rejects(core.readLifetimeStats(directory),/event changed/);
});

test("recovered same-ID retry publishes a second completion once",async t => {
  const {directory,write,journal} = await create(t);
  await write("stats.json",fixture.stats_before);
  await write("logs/latest-decision.json",fixture.snapshot_before);
  await write("logs/events.jsonl",fixture.events_before);
  await fs.rm(path.join(directory,"logs/.decision-publication.json"));
  assert.equal((await core.readLifetimeStats(directory)).completed,1);
  await journal("prepared");
  await write("stats.json",fixture.stats_after);
  await write("logs/latest-decision.json",fixture.snapshot_after);
  await write("logs/events.jsonl",fixture.events_before+fixture.event);
  assert.equal((await core.readLifetimeStats(directory)).completed,1);
  await journal("committed");
  assert.equal((await core.readLifetimeStats(directory)).completed,2);
  await fs.rm(path.join(directory,"logs/.decision-publication.json"));
  assert.equal((await core.readLifetimeStats(directory)).completed,2,"older writers remain readable without a journal");
});

test("same-content atomic journal replacement retries the reader generation",async t => {
  const {directory,write} = await create(t);
  const open = fs.open; let reads = 0;
  fs.open = async function(filename,...args) {
    const handle = await open.call(this,filename,...args);
    if (filename === path.join(directory,"stats.json")) {
      reads += 1;
      if (reads === 1) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          await write("logs/.replacement-journal",JSON.stringify(fixture.prepared));
          await fs.rename(path.join(directory,"logs/.replacement-journal"),path.join(directory,"logs/.decision-publication.json"));
        };
      }
    }
    return handle;
  };
  try { assert.equal((await core.readLifetimeStats(directory)).completed,1);assert.equal(reads,2); }
  finally { fs.open = open; }
});

test("counter and journal codecs reject lossy UTF8, BOM and non-integer tokens while probabilities stay valid",async t => {
  const {directory,write} = await create(t);
  await fs.rm(path.join(directory,"logs/.decision-publication.json"));
  const health = '{"version":1,"hook_version":"0.11.4","last_seen_ms":1,"last_skip":"';
  await write("logs/hook-health.json",Buffer.concat([Buffer.from(health),Buffer.from([0xff]),Buffer.from('"}') ]));
  await assert.rejects(core.readHookHealth(directory),/encoded data|encoding/i);
  await write("logs/hook-health.json",Buffer.from('\ufeff'+health+'ok"}'));
  await assert.rejects(core.readHookHealth(directory),/JSON/);
  for (const token of ["1.0","1e0","-0"]) {
    await write("logs/hook-health.json",`{"version":1,"hook_version":"0.11.4","last_seen_ms":1,"seen":${token}}`);
    await assert.rejects(core.readHookHealth(directory),/unsigned counter token/);
    await write("stats.json",`{"calls":${token},"completed":1}`);
    await assert.rejects(core.readLifetimeStats(directory),/unsigned counter token/);
    assert.throws(()=>validateJournal(Buffer.from(JSON.stringify(fixture.prepared).replace('"event_offset":'+fixture.prepared.event_offset,'"event_offset":'+token))),/unsigned counter token/);
  }
  assert.equal(parseUniqueJson(Buffer.from('{"probability":0.9}')).probability,.9);
  assert.equal(parseUnsignedJson('{"count":1,"probability":0.9}',keys=>keys[0]==="count").probability,.9);
});
