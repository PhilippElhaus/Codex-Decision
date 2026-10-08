"use strict";
// Real hook processes, a shared private session, and a bounded loopback mock.
const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const http=require("node:http");
const crypto=require("node:crypto");
const assert=require("node:assert/strict");
const {invoke,stopOwned,ownedPids}=require("./pipeline-stress/process.cjs");
const {sampler}=require("./pipeline-stress/resources.cjs");
const {fixture,response,faultyResponse,faultMessages}=require("../tests/fixtures/pipeline-stress.cjs");
const {readLatestPanelDecision}=require("../vscode-control/panel-state");
const {Latencies}=require("./pipeline-stress/latency.cjs");
const {InvocationFingerprint,foldInvocations}=require("./pipeline-stress/fingerprints.cjs");
const {requireProxyHook}=require("./two_stage_audit.cjs");
const arg=(flag,fallback)=>process.argv.includes(flag)?process.argv[process.argv.indexOf(flag)+1]:fallback;
const hash=text=>crypto.createHash("sha256").update(text).digest("hex");
async function json(file){return JSON.parse(await fs.readFile(file,"utf8"));}

async function main() {
  const hook=path.resolve(arg("--hook",path.join(os.homedir(),".cache/codex-decision/pipeline-candidate-20261007/debug/decision-hook")));
  const hookDetails=await fs.lstat(hook);
  if(!hookDetails.isFile()||hookDetails.isSymbolicLink()||hookDetails.size>128*1024*1024)throw new Error("Invalid testing hook executable");
  requireProxyHook(await fs.readFile(hook));
  const provider=arg("--provider","openai");if(!["openai","typesafe"].includes(provider))throw new Error("Invalid provider");
  const concurrency=Number(arg("--concurrency","4")),rounds=Number(arg("--rounds","32")),minutes=Number(arg("--minutes","0")),limitMb=Number(arg("--log-limit-mb","1"));
  const counts=arg("--lines","64,512,2000,10000").split(",").map(Number);
  const faults=arg("--faults","http").split(","),jitter=Number(arg("--jitter-ms","0"));
  const allowDeadline=process.argv.includes("--allow-deadline");
  const allowStorageFaults=process.argv.includes("--allow-storage-faults");
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16||!Number.isInteger(rounds)||rounds<1||rounds>100000||!Number.isFinite(minutes)||minutes<0||minutes>480||
    !Number.isInteger(limitMb)||limitMb<1||limitMb>50||counts.length>16||counts.some(n=>!Number.isInteger(n)||n<32||n>10000)||
    !Number.isInteger(jitter)||jitter<0||jitter>250||faults.some(mode=>!Object.hasOwn(faultMessages,mode)))throw new Error("Stress limits are invalid");
  const out=path.resolve(arg("--out",`.local/quality/pipeline-stress-${Date.now()}`));await fs.mkdir(out,{recursive:true,mode:0o700});
  const temporaryRoot=await fs.realpath(os.tmpdir());
  if(temporaryRoot==="/mnt/d"||temporaryRoot.startsWith("/mnt/d/")||/^d:[\\/]/i.test(temporaryRoot))throw new Error("Stress fixtures must stay off D:");
  const temporary=await fs.mkdtemp(path.join(temporaryRoot,"decision-pipeline-stress-"));
  let server,resources;
  try {
  const data=path.join(temporary,"data");await fs.mkdir(data,{mode:0o700});
  const session="pipeline-stress",scoped=path.join(data,"sessions",hash(session));
  const model=provider==="openai"?"gpt-6-luna":"jev-latest";
  await fs.writeFile(path.join(data,"config.json"),JSON.stringify({schema_version:5,scope:"global",enabled:true,mode:"replace",provider,model,
    relevance_policy:{relevant_max:5},timeout_seconds:4,log_limit_mb:limitMb,never_delete_logs:false}),{mode:0o600});
  await fs.writeFile(path.join(data,".env"),`${provider==="openai"?"OPENAI_API_KEY":"JEV_API_KEY"}=synthetic-stress-key\n`,{mode:0o600});
  const transcript=path.join(temporary,"transcript.jsonl");
  await fs.writeFile(transcript,JSON.stringify({type:"response_item",payload:{role:"user",content:[{type:"input_text",text:"Identify the failure cause and final status. Preserve their exact values."}]}})+"\n");
  let active=new Map(),requests=0,successfulCalls=0,successes=0,failures=0,deadlineFallbacks=0,sourceBytes=0,savedBytes=0,lastCompletedRuns=[];
  let requestBytes=0,targetQuestions=0,contextOnlyRows=0,statusWriteFailures=0;
  const expectedStages={responses_received:0,responses_validated:0,request_failures:0,request_cancelled:0};
  let stageCounts,stageAccounting="legacy hook before 0.11.5; outcome assertions unavailable";
  const latencies=new Latencies(),wireDigest=crypto.createHash("sha256");
  const resultDigest=crypto.createHash("sha256");
  const unexpected=[];
  server=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,"Bearer synthetic-stress-key");
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size+4096>64000)throw new Error("Request budget");chunks.push(chunk);}
      const encoded=Buffer.concat(chunks);
      const wire=JSON.parse(encoded);const state=wire.input?JSON.parse(wire.input):wire.state;
      const id=state.command.match(/run-\d+-\d+/)?.[0],run=active.get(id);if(!run)throw new Error("Unknown stress request");
      run.wireFingerprint.add(encoded);requestBytes+=encoded.length;
      run.calls++;requests++;
      if(jitter)await new Promise(resolve=>setTimeout(resolve,(requests*17)% (jitter+1)));
      const first=Array.isArray(wire.questions)?wire.questions[0]?.name==="output_kind":!!wire.questions.output_kind;
      if(!first){targetQuestions+=Array.isArray(wire.questions)?wire.questions.length:Object.keys(wire.questions).length;
        contextOnlyRows+=(state.lines||[]).filter(line=>!line.target).length;}
      if(run.fault && (run.count<200||run.calls>=2)){
        if(run.faultMode==="timeout")await new Promise(resolve=>setTimeout(resolve,4500));
        res.writeHead(run.faultMode==="http"?500:200,{"Content-Type":"application/json"});
        res.end(run.faultMode==="http"?"{}":faultyResponse(wire,provider,run.faultMode));return;
      }
      if(first)run.classified=true;
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify(response(wire,provider)));
    }catch(error){
      if(!(allowDeadline&&req.aborted&&["ECONNRESET","ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)))unexpected.push(error.message);
      res.writeHead(500,{"Content-Type":"application/json"});res.end("{}");
    }
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint=`http://127.0.0.1:${server.address().port}/`;
  const started=Date.now(),deadline=minutes?started+minutes*60000:Infinity;
  resources=sampler(ownedPids);
  let group=0;
    while((minutes?Date.now()<deadline:group<rounds)) {
      const count=counts[group%counts.length];
      const runs=Array.from({length:concurrency},(_,worker)=>({...fixture(group,worker,count),count,calls:0,faultMode:faults[group%faults.length],wireFingerprint:new InvocationFingerprint()}));
      active=new Map(runs.map(run=>[run.id,run]));
      const results=await Promise.all(runs.map(run=>invoke(hook,data,endpoint,{hook_event_name:"PostToolUse",tool_name:run.envelope?"exec_command":"Bash",
        session_id:session,tool_use_id:run.id,transcript_path:transcript,tool_input:run.envelope?{cmd:run.command}:{command:run.command},tool_response:run.response})));
      const verifiedOriginals=[],completed=[];
      for(let i=0;i<runs.length;i++) {
        const run=runs[i],result=results[i],file=path.join(data,"outputs",hash(session).slice(0,20),`${hash(run.id).slice(0,20)}.txt`);
        // Each deliberate failure ends at its final request; earlier answers
        // passed the typed validator. A timeout returns no HTTP headers.
        expectedStages.responses_received+=run.calls-Number(run.fault&&run.faultMode==="timeout");
        expectedStages.responses_validated+=run.calls-Number(run.fault);
        expectedStages.request_failures+=Number(run.fault);
        const storageFaults=(result.stderr.match(/^Codex Decision status write failed: .+$/gm)||[]).length;
        assert.ok(storageFaults<=1,"Each invocation may report at most one failed error-ledger write");
        if(storageFaults){assert.ok(allowStorageFaults&&run.fault,"Candidate acceptance requires zero lost telemetry");statusWriteFailures+=storageFaults;}
        const stableReply={...result.reply};
        if(typeof stableReply.reason==="string")stableReply.reason=stableReply.reason
          .split(file.replace(/\.txt$/,".json")).join("/synthetic/original.json")
          .split(file).join("/synthetic/original.txt");
        resultDigest.update(run.id+"\0").update(JSON.stringify(stableReply)+"\0");
        const deadline=!run.fault && allowDeadline && ["Codex Decision hook skipped: hook deadline\n","Codex Decision hook skipped: Decision request failed\n"].includes(result.stderr);
        latencies.add(count,deadline?"deadline":run.fault?"failure":"success",result.elapsedMs);
        if(deadline){assert.deepEqual(result.reply,{});await assert.rejects(fs.stat(file));deadlineFallbacks++;continue;}
        if(run.fault){assert.deepEqual(result.reply,{});assert.ok(result.stderr.includes(faultMessages[run.faultMode]),result.stderr);await assert.rejects(fs.stat(file));failures++;continue;}
        assert.equal(result.stderr,"");assert.equal(result.reply.continue,false);
        const original=await fs.readFile(file,"utf8");assert.ok(original.endsWith(run.source));
        verifiedOriginals.push(file);
        if(run.envelope){const typed=file.replace(/\.txt$/,".json");assert.deepEqual(await json(typed),run.response);verifiedOriginals.push(typed);}else assert.equal(original,run.source);
        assert.ok(result.reply.reason.includes("endpoint example.invalid port 8443"));assert.ok(result.reply.reason.includes("return value 73"));
        const sourceLines=new Set(run.source.split(/\r?\n/).filter(Boolean));
        for(const line of result.reply.reason.split(/\r?\n/).filter(line=>line.startsWith("INFO ")||line.startsWith("ERROR:")||line.startsWith("Run ended")))assert.ok(sourceLines.has(line));
        successes++;successfulCalls+=run.calls;sourceBytes+=Buffer.byteLength(original);savedBytes+=Buffer.byteLength(original)-Buffer.byteLength(result.reply.reason);
        completed.push(run);
      }
      foldInvocations(wireDigest,runs);
      const stats=await json(path.join(scoped,"stats.json")).catch(error=>{if(error.code==="ENOENT"&&successes===0)return {replaced:0,completed:0,calls:0};throw error;});
      assert.deepEqual(unexpected,[],"The mock must reject malformed or unknown requests during pressure checks");
      assert.equal(stats.replaced,successes);assert.equal(stats.completed,successes);assert.equal(stats.calls,successfulCalls);
      if(completed.length)lastCompletedRuns=completed;
      const panel=await readLatestPanelDecision(scoped);
      if(lastCompletedRuns.length){assert.equal(panel.status,"replace");assert.ok(lastCompletedRuns.some(run=>panel.rows.length===run.projectedLines&&panel.rows.some(row=>row.excerpt.includes(run.id))));}
      else assert.equal(panel,null);
      const health=await json(path.join(scoped,"logs/hook-health.json"));assert.equal(health.seen,(group+1)*concurrency);
      assert.equal(health.api_requests,requests,"Saved attempts must include successful and deliberately failed requests");
      const version=/^(\d+)\.(\d+)\.(\d+)$/.exec(health.hook_version||"");
      assert.ok(version,"Health metadata must identify its hook version");
      if(Number(version[1])>0||Number(version[2])>11||Number(version[2])===11&&Number(version[3])>=5){
        assert.equal(deadlineFallbacks,0,"Stage accounting acceptance requires zero deadline fallbacks");
        stageCounts=Object.fromEntries(Object.keys(expectedStages).map(key=>[key,health[key]]));
        assert.deepEqual(stageCounts,expectedStages,"Every request must settle into its exact observed outcome stage");
        stageAccounting="all outcome counters verified";
      }
      assert.equal(health.errors+statusWriteFailures,failures+deadlineFallbacks,"Persisted errors and explicit storage faults must reconcile every failed invocation");
      const files=await fs.readdir(path.join(scoped,"logs"),{recursive:true});let managed=0;
      for(const name of files){assert.ok(!/\.pending$|\.tmp$/.test(name));if(/^(receipt|batch)-/.test(path.basename(name)))managed+=(await fs.stat(path.join(scoped,"logs",name))).size;}
      assert.ok(managed<=limitMb*1000000);
      // These are exact originals verified in this disposable fixture. Remove
      // only those closed files to keep multi-hour checks within a fixed budget.
      for(const file of verifiedOriginals){const metadata=await fs.lstat(file);assert.ok(metadata.isFile()&&!metadata.isSymbolicLink());await fs.unlink(file);}
      group++;
      if(group%8===0||!minutes&&group===rounds){const status={group,provider,invocations:successes+failures+deadlineFallbacks,successes,deliberate_failures:failures,deadline_fallbacks:deadlineFallbacks,mock_requests:requests,
        source_bytes:sourceBytes,saved_bytes:savedBytes,status_write_failures:statusWriteFailures,request_outcomes:stageCounts||null,outcome_assertions:stageAccounting,managed_log_bytes:managed,elapsed_ms:Date.now()-started};console.log(JSON.stringify(status));await fs.writeFile(path.join(out,"progress.json"),JSON.stringify(status,null,2)+"\n");}
    }
    const memory=await resources.stop();
    assert.deepEqual(memory.sampling_errors,[],"Owned runtime memory sampling must remain available");
    const snapshot=path.join(scoped,"logs/latest-decision.json");
    if(lastCompletedRuns.length){const metadata=await fs.lstat(snapshot);assert.ok(metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.size<=8*1024*1024);await fs.copyFile(snapshot,path.join(out,"latest-decision.json"));}
    const summary={provider,groups:group,invocations:successes+failures+deadlineFallbacks,successes,deliberate_failures:failures,deadline_fallbacks:deadlineFallbacks,mock_requests:requests,source_bytes:sourceBytes,saved_bytes:savedBytes,
      request_sha256:wireDigest.digest("hex"),result_sha256:resultDigest.digest("hex"),request_bytes:requestBytes,
      relevance_questions:targetQuestions,context_only_rows:contextOnlyRows,status_write_failures:statusWriteFailures,request_outcomes:stageCounts||null,outcome_assertions:stageAccounting,sampled_memory:memory,latency_ms:latencies.summary(),elapsed_ms:Date.now()-started};
    await fs.writeFile(path.join(out,"summary.json"),JSON.stringify(summary,null,2)+"\n");console.log(JSON.stringify(summary));
  }finally{
    if(resources)await resources.stop();
    await stopOwned();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(await fs.realpath(temporary),temporary);assert.ok((await fs.lstat(temporary)).isDirectory());
    const entries=await fs.readdir(temporary,{recursive:true});for(const item of entries)assert.equal((await fs.lstat(path.join(temporary,item))).isSymbolicLink(),false);
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
