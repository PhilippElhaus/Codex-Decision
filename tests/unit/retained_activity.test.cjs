"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),test=require("node:test");
const cases=require("../fixtures/retained-activity.json");
const {retainedStatsFromEvents,readLifetimeStats}=require("../../vscode-control/core");
const {parseUniqueJson}=require("../../vscode-control/private-records");
const {validateJournal}=require("../../vscode-control/publication-journal");
const publication=require("../fixtures/publication-case.json");
const crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");
const cli=process.env.DECISIONCTL_TEST||path.resolve(__dirname,"../../target/verification/decisionctl");
function bytesFor(case_) {
  let source=case_.source||"";
  if(case_.repeat_reason)source=JSON.stringify({status:"replace",reason:"λ".repeat(case_.repeat_reason),requests:1})+"\n";
  if(case_.prefix_repeat)source='{"status":"keep","reason":"kept","requests":1}\n'.repeat(case_.prefix_repeat)+source;
  const bytes=Buffer.from(source);if(case_.invalid_utf8)bytes[bytes.indexOf("synthetic")]=0xff;return bytes;
}
test("shared retained fixtures match the Rust exact or unavailable contract",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"decision-retained-contract-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(directory,"logs"),{mode:0o700});
  for(const case_ of cases) {
    const bytes=bytesFor(case_),start=Math.max(0,bytes.length-1_048_576);
    await fs.writeFile(path.join(directory,"logs/events.jsonl"),bytes,{mode:0o600});
    if(case_.node_error) {
      assert.throws(()=>retainedStatsFromEvents(bytes.subarray(start),start>0),new RegExp(case_.node_error),case_.id);
      await assert.rejects(readLifetimeStats(directory),new RegExp(case_.node_error),case_.id);continue;
    }
    const expected={calls:0,completed:0,replaced:0,savedChars:0,timed:0,elapsedMs:0,...case_.expected};
    assert.deepEqual(retainedStatsFromEvents(bytes.subarray(start),start>0),expected,case_.id);
    const disk=await readLifetimeStats(directory);
    for(const[name,value]of Object.entries(expected))assert.equal(disk[name],value,`${case_.id}: ${name}`);
    assert.equal(disk.averageMs,null);
  }
});
test("journal codec rejects unpaired escaped UTF16 in values and keys without changing valid Unicode",()=>{
  for(const json of ['{"value":"\\ud800"}','{"\\udc00":1}'])assert.throws(()=>parseUniqueJson(json),/Unicode/);
  assert.equal(parseUniqueJson('{"value":"\\ud83d\\ude00"}').value,"😀");
  const commit='{"status":"replace","reason":"\\ud800","requests":1}\n';
  const journal={...publication.prepared,commit_event:commit,commit_sha256:crypto.createHash("sha256").update(commit).digest("hex")};
  assert.throws(()=>validateJournal(Buffer.from(JSON.stringify(journal))),/Unicode/);
  for(const case_ of cases.filter(value=>value.journal_valid !== undefined)) {
    const journal={...publication.prepared,commit_event:case_.source,commit_sha256:crypto.createHash("sha256").update(case_.source).digest("hex")};
    if(case_.journal_valid)assert.ok(validateJournal(Buffer.from(JSON.stringify(journal))),case_.id);
    else assert.throws(()=>validateJournal(Buffer.from(JSON.stringify(journal))),/Unicode/,case_.id);
  }
});
test("bounded retained reads request at most one MiB from the opened event inode",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"decision-retained-bound-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(directory,"logs"),{mode:0o700});
  const filename=path.join(directory,"logs/events.jsonl");await fs.writeFile(filename,bytesFor(cases.find(value=>value.id==="bounded-tail")),{mode:0o600});
  const open=fs.open;let readBytes=0;
  fs.open=async function(file,...args){const handle=await open.call(this,file,...args);if(file===filename){const read=handle.read.bind(handle);handle.read=async(...args)=>{const result=await read(...args);readBytes+=result.bytesRead;return result;};}return handle;};
  try{await readLifetimeStats(directory);}finally{fs.open=open;}
  assert.equal(readBytes,1_048_576);
});
test("Rust CLI and Node retained views agree on shared adversarial fixtures",{skip:!require("node:fs").existsSync(cli)},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"decision-retained-differential-"));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const session="synthetic-retained-differential",scoped=path.join(directory,"sessions",crypto.createHash("sha256").update(session).digest("hex"));
  await fs.mkdir(path.join(scoped,"logs"),{recursive:true,mode:0o700});
  for(const case_ of cases) {
    await fs.writeFile(path.join(scoped,"logs/events.jsonl"),bytesFor(case_),{mode:0o600});
    const rust=spawnSync(cli,["activity","--data-dir",directory,"--session",session],{encoding:"utf8"});
    assert.equal(rust.status,0,`${case_.id}: ${rust.stderr}`);
    const result=JSON.parse(rust.stdout).metrics;
    if(case_.node_error) {
      await assert.rejects(readLifetimeStats(scoped),new RegExp(case_.node_error));
      assert.ok(rust.stdout.includes('"savedChars":9007199254740992'));continue;
    }
    const node=await readLifetimeStats(scoped);
    for(const name of ["calls","completed","replaced","savedChars","timed","elapsedMs"])assert.equal(node[name],result[name],`${case_.id}: ${name}`);
  }
});
