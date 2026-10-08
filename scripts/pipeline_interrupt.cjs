"use strict";
// Kill a real hook after one relevance batch, then verify the next completion.
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),http=require("node:http");
const crypto=require("node:crypto"),assert=require("node:assert/strict");
const {fixture,response}=require("../tests/fixtures/pipeline-stress.cjs");
const {start,invoke,stopOwned}=require("./pipeline-stress/process.cjs");
const {readLatestPanelDecision}=require("../vscode-control/panel-state");
const {requireProxyHook}=require("./two_stage_audit.cjs");
const arg=(flag,fallback)=>process.argv.includes(flag)?process.argv[process.argv.indexOf(flag)+1]:fallback;
const hash=text=>crypto.createHash("sha256").update(text).digest("hex");
const json=async file=>JSON.parse(await fs.readFile(file,"utf8"));

async function verify(hook,provider) {
  const temporaryRoot=await fs.realpath(os.tmpdir());
  if(temporaryRoot==="/mnt/d"||temporaryRoot.startsWith("/mnt/d/")||/^d:[\\/]/i.test(temporaryRoot))throw new Error("Interruption fixtures must stay off D:");
  const temporary=await fs.mkdtemp(path.join(temporaryRoot,"decision-pipeline-interrupt-"));
  let server,release;
  try {
    const data=path.join(temporary,"data");await fs.mkdir(data,{mode:0o700});
    const session="pipeline-interrupt",scoped=path.join(data,"sessions",hash(session)),logs=path.join(scoped,"logs");
    await fs.writeFile(path.join(data,"config.json"),JSON.stringify({schema_version:5,scope:"global",enabled:true,mode:"replace",provider,
      model:provider==="openai"?"gpt-6-luna":"jev-latest",relevance_policy:{relevant_max:5},timeout_seconds:4,never_delete_logs:true}),{mode:0o600});
    await fs.writeFile(path.join(data,".env"),`${provider==="openai"?"OPENAI_API_KEY":"JEV_API_KEY"}=synthetic-interrupt-key\n`,{mode:0o600});
    const transcript=path.join(temporary,"transcript.jsonl");
    await fs.writeFile(transcript,JSON.stringify({type:"response_item",payload:{role:"user",content:[{type:"input_text",text:"Identify the failure cause and final status. Preserve their exact values."}]}})+"\n");
    let reached,requests=0,relevance=0;
    const paused=new Promise(resolve=>reached=resolve),released=new Promise(resolve=>release=resolve),unexpected=[];
    server=http.createServer(async(req,res)=>{
      try {
        assert.equal(req.headers.authorization,"Bearer synthetic-interrupt-key");
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assert.ok(size+4096<=64000);chunks.push(chunk);}
        const wire=JSON.parse(Buffer.concat(chunks)),state=wire.input?JSON.parse(wire.input):wire.state;
        requests++;
        const classification=Array.isArray(wire.questions)?wire.questions[0]?.name==="output_kind":!!wire.questions.output_kind;
        if(state.command.includes("run-0-1")&&!classification&&++relevance===2){reached();await released;res.destroy();return;}
        res.setHeader("Content-Type","application/json");res.end(JSON.stringify(response(wire,provider)));
      }catch(error){unexpected.push(error.message);res.writeHead(500);res.end("{}");}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const endpoint=`http://127.0.0.1:${server.address().port}/`;
    const event=run=>({hook_event_name:"PostToolUse",tool_name:"exec_command",session_id:session,tool_use_id:run.id,
      transcript_path:transcript,tool_input:{cmd:run.command},tool_response:run.response});
    const interrupted=fixture(0,1,512),running=start(hook,data,endpoint,event(interrupted));
    const timer=setTimeout(()=>{release();},10000);
    try {
      await Promise.race([paused,running.done.then(()=>{throw new Error("Hook exited before the interruption barrier");})]);
      const processing=await json(path.join(logs,"latest-decision.json"));
      assert.equal(processing.status,"processing");assert.equal(processing.batch.number,1);
      assert.ok(processing.totals.judged>0);assert.equal(processing.rows.length,interrupted.projectedLines);
      assert.equal(running.child.kill("SIGKILL"),true);
      const killed=await running.done;assert.equal(killed.signal,"SIGKILL");assert.equal(killed.stdout,"");
    }finally{clearTimeout(timer);release();}
    // Coverage metadata may bootstrap a zero ledger before a completion.
    const uncommittedStats=await json(path.join(scoped,"stats.json")).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
    if(uncommittedStats)for(const name of ["completed","replaced","calls","savedChars","linesActuallyOmitted"])assert.equal(uncommittedStats[name]??0,0);
    await assert.rejects(fs.stat(path.join(data,"outputs")),{code:"ENOENT"});
    assert.equal((await fs.readdir(logs,{recursive:true})).some(file=>/^(receipt|batch)-|\.pending$|\.tmp$/.test(path.basename(file))),false);
    assert.equal((await fs.readFile(path.join(logs,"events.jsonl"),"utf8")).includes('"status":"replace"'),false);
    const next=fixture(1,1,512),result=await invoke(hook,data,endpoint,event(next));
    assert.equal(result.stderr,"");assert.equal(result.reply.continue,false);
    const original=path.join(data,"outputs",hash(session).slice(0,20),`${hash(next.id).slice(0,20)}.txt`);
    assert.equal(await fs.readFile(original,"utf8"),'Command result metadata: {"exit_code":1}\n'+next.source);
    assert.deepEqual(await json(original.replace(/\.txt$/,".json")),next.response);
    assert.ok(result.reply.reason.includes("ERROR: synthetic endpoint example.invalid port 8443 refused the connection."));
    assert.ok(result.reply.reason.includes("Run ended with return value 73."));
    const stats=await json(path.join(scoped,"stats.json"));assert.equal(stats.completed,1);assert.equal(stats.replaced,1);
    const panel=await readLatestPanelDecision(scoped);assert.equal(panel.status,"replace");assert.equal(panel.rows.length,next.projectedLines);
    assert.ok(panel.rows.some(row=>row.excerpt.includes(next.id)));assert.deepEqual(unexpected,[]);
    return {provider,killed_after_relevance_batch:1,successful_retry:true,mock_requests:requests};
  }finally{
    if(release)release();await stopOwned();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(await fs.realpath(temporary),temporary);assert.ok((await fs.lstat(temporary)).isDirectory());
    for(const item of await fs.readdir(temporary,{recursive:true}))assert.equal((await fs.lstat(path.join(temporary,item))).isSymbolicLink(),false);
    await fs.rm(temporary,{recursive:true,force:true});
  }
}

async function main() {
  const hook=path.resolve(arg("--hook",path.join(os.homedir(),".cache/codex-decision/pipeline-candidate-20261007/debug/decision-hook")));
  const details=await fs.lstat(hook);
  if(!details.isFile()||details.isSymbolicLink()||details.size>128*1024*1024)throw new Error("Invalid testing hook executable");
  requireProxyHook(await fs.readFile(hook));
  const results=[];for(const provider of ["openai","typesafe"])results.push(await verify(hook,provider));
  const out=path.resolve(arg("--out",`.local/quality/pipeline-interrupt-${Date.now()}`));
  await fs.mkdir(out,{recursive:true,mode:0o700});await fs.writeFile(path.join(out,"summary.json"),JSON.stringify(results,null,2)+"\n");
  console.log(JSON.stringify(results));
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
