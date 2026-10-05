"use strict";
// Exercises the real debug hook. Live mode forwards only synthetic fixture data.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { spawn, spawnSync } = require("node:child_process");
const fixtures = require("../tests/fixtures/two-stage-cases.cjs");
const holdout = require("../tests/fixtures/two-stage-holdout.cjs");
const batching = require("../tests/fixtures/batching-cases.cjs");
const { readApiKey, sessionDirectory } = require("../vscode-control/core");
const { readLatestPanelDecision } = require("../vscode-control/panel-state");
const kinds = ["repetitive_log", "progress_output", "independent_matches", "independent_records", "exact_content", "prose", "structured_payload", "mixed_or_unknown"];
const faults = ["choice-missing", "choice-extra", "choice-sum", "choice-argmax", "choice-class", "choice-confidence", "choice-type", "choice-model", "choice-json", "choice-http401", "choice-http429", "choice-http529", "choice-timeout", "line-missing", "line-extra", "line-type", "line-range", "line-confidence", "line-json", "line-http500", "line-timeout", "line-oversized"];
faults.push("line-late-missing", "line-late-extra", "line-late-http422", "line-late-http500", "line-late-timeout");
const arg = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
async function main() {
  const live = process.argv.includes("--live");
  if (live && !process.argv.includes("--data-dir")) throw new Error("Live mode requires --data-dir; the saved key stays in memory.");
  const key = live ? await readApiKey(arg("--data-dir")) : null;
  const hook = path.resolve(arg("--hook", path.join(os.homedir(), ".cache/codex-jev/cargo-target/debug/jev-hook")));
  const out = path.resolve(arg("--out", `.local/two-stage/${live ? "live" : "offline"}-${Date.now()}`));
  const maxCalls = Number(arg("--max-calls", "120"));
  const maxTokens = Number(arg("--max-tokens", "500000"));
  const relevantMax = Number(arg("--relevance-max", "5"));
  if (!Number.isInteger(relevantMax) || relevantMax < 0 || relevantMax > 100) throw new Error("Relevance cutoff must be an integer from 0 to 100");
  if (![maxCalls,maxTokens].every(value=>Number.isInteger(value)&&value>0)) throw new Error("Evaluation budgets must be positive integers");
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jev-two-stage-"));
  if (temporary.startsWith("/mnt/d/")) throw new Error("Temporary work must be off D:");
  let current, calls = 0, totalCalls = 0, inputTokens = 0, outputTokens = 0;
  const reports = [];
  const qualityCases = [];
  let judged = new Set(), requestBudgets = [], protocolFailures = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes + 4096 > 64000) throw new Error("request limit"); chunks.push(chunk); }
      const request = JSON.parse(Buffer.concat(chunks));
      calls += 1; totalCalls += 1;
      const first = !!request.questions.output_kind;
      const caseId=current.id;
      const stage=calls;
      const budget={state_longest_question_bound:Buffer.byteLength(JSON.stringify(request.state))+
        Math.max(...Object.values(request.questions).map(question=>Buffer.byteLength(JSON.stringify(question))))+4096,
        whole_request_bound:bytes+4096};
      requestBudgets.push(budget);
      if (budget.state_longest_question_bound>32000 || budget.whole_request_bound>64000 || first && calls!==1) {
        protocolFailures.push("request budget or stage order");throw new Error("invalid packing");
      }
      if (!first) for (const id of Object.keys(request.questions)) {
        const number=Number(id.slice(5));
        const row=request.state.lines.find(line=>line.line===number && line.target===true);
        const expected=(current.sourceLines || current.lines)[number-1]?.replace(/[\r\n]+$/g,"").replace(/\x1b\[[0-9;]*[A-Za-z]/g,"");
        if (judged.has(number) || !row || row.text!==expected) protocolFailures.push("duplicate, missing or truncated target");
        judged.add(number);
      }
      if (live) {
        if (totalCalls > maxCalls || inputTokens + outputTokens >= maxTokens) throw new Error("live evaluation budget");
        const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST",
          headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"},
          body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
        const text = await response.text();
        const dest = path.join(out,caseId);await fs.mkdir(dest,{recursive:true,mode:0o700});
        await fs.writeFile(path.join(dest,`remote-call-${stage}.json`), JSON.stringify({request,status:response.status,response:JSON.parse(text)},null,2)+"\n");
        try { const body = JSON.parse(text); inputTokens += body.usage?.input_tokens || 0; outputTokens += body.usage?.output_tokens || 0;
          if (body.usage?.input_tokens>budget.whole_request_bound) protocolFailures.push("reported usage exceeds conservative request bound"); } catch {}
        res.writeHead(response.status, {"Content-Type":"application/json"});res.end(text);return;
      }
      const relevant = new Set(current.requiredLines || current.required_lines);
      let body = { model: "jev-1.13.0", usage: {input_tokens: 100, output_tokens: 30}, answers: first ? {
        output_kind: { type:"choice", choice:current.kind, confidence:0.96,
          probabilities:Object.fromEntries(kinds.map(kind => [kind, kind === current.kind ? .98 : .02 / 7])) }
      } : Object.fromEntries(Object.keys(request.questions).map(id => [id, {type:"noul", noul: relevant.has(Number(id.slice(5))) ? .99 : .01}])) };
      const late = current.fault?.startsWith("line-late-");
      const fault = (current.fault || "").replace("line-late-", "line-");
      if ((!late || calls>=3) && ((first && fault.startsWith("choice-")) || (!first && fault.startsWith("line-")))) {
        const suffix = fault.slice(fault.indexOf("-") + 1);
        if (suffix === "timeout") { setTimeout(() => res.end("{}"), 500);return; }
        if (suffix.startsWith("http")) {res.writeHead(Number(suffix.slice(4)));res.end("{}");return;}
        if (suffix === "json") {res.end("{broken");return;}
        if (suffix === "oversized") {res.end("x".repeat(1000001));return;}
        const id = Object.keys(body.answers)[0];
        if (suffix === "missing") delete body.answers[id];
        if (suffix === "extra") body.answers.unexpected = {type:"noul",noul:.01};
        if (suffix === "type") body.answers[id].type = "score";
        if (suffix === "confidence") body.answers[id].confidence = first ? 1.1 : .99;
        if (suffix === "model") body.model = "other-model";
        if (suffix === "range") body.answers[id].noul = 1.1;
        if (suffix === "class") body.answers[id].choice = "invented";
        if (suffix === "sum") body.answers[id].probabilities.repetitive_log = .5;
        if (suffix === "argmax") {body.answers[id].choice = "prose";}
      }
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify(body));
    } catch { if (!res.headersSent) res.writeHead(502);res.end("{}"); }
  });
  try {
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    let selected = (process.argv.includes("--batching") ? batching : process.argv.includes("--holdout") ? holdout : fixtures).filter(item => !process.argv.includes("--case") || arg("--case").split(",").includes(item.id));
    if (!selected.length) throw new Error("No matching case");
    if (!live && !process.argv.includes("--case")) selected = [...selected,
      ...faults.map(fault => {
        const fixture=fixtures.find(item => item.id === "log-failure-240");
        return {...fixture, id:fault, fault, expect_full:true,
          lines:fault.startsWith("choice-") ? fixture.lines.map(line=>line.replace(/^INFO /,"Routine ")) : fixture.lines};
      })];
    for (const item of selected) {
      current = item;calls = 0;judged = new Set();requestBudgets=[];protocolFailures=[];
      const data = path.join(temporary,item.id);await fs.mkdir(data,{mode:0o700});
      await fs.writeFile(path.join(data,".env"),"JEV_API_KEY=synthetic-proxy-key\n",{mode:0o600});
      await fs.writeFile(path.join(data,"config.json"),JSON.stringify({schema_version:4,scope:"global",enabled:item.enabled !== false,
        mode:item.mode || "replace",model:"jev-latest",timeout_seconds:item.fault?.endsWith("timeout") ? .15 : 4,
        relevance_policy:{relevant_max:relevantMax}}),{mode:0o600});
      const transcript=path.join(data,"transcript.jsonl");
      await fs.writeFile(transcript,JSON.stringify({type:"response_item",payload:{role:"user",content:[{type:"input_text",text:item.task}]}})+"\n");
      const newline=item.newline || "\n";
      const source=item.lines.join(newline)+(item.terminated === false ? "" : newline);
      const projectedSource=item.metadata ? 'Command result metadata: {"exit_code":1}\n'+source : source;
      const requiredLines=item.required_lines.map(number=>number+Number(!!item.metadata));
      current.sourceLines=projectedSource.split(/\r?\n/).filter((_,index,all)=>index!==all.length-1||all[index]!=="");
      current.requiredLines=requiredLines;
      const event={hook_event_name:"PostToolUse",tool_name:item.tool || "Bash",session_id:item.id,tool_use_id:"synthetic-call",transcript_path:transcript,
        tool_input:{command:item.command},tool_response:item.metadata ? {output:source,exit_code:1} : source};
      if (item.no_transcript) delete event.transcript_path;
      const started=Date.now();
      const child=spawn(hook,[],{env:{...process.env,PLUGIN_DATA:data,CODEX_JEV_TEST_ENDPOINT:`http://127.0.0.1:${server.address().port}/`},stdio:["pipe","pipe","pipe"]});
      let stdout="",stderr="";child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
      child.stdin.end(JSON.stringify(event));
      const code=await new Promise((resolve,reject)=>{child.on("error",reject);child.on("close",resolve);});
      if (code !== 0) throw new Error(`Hook crashed: ${item.id}`);
      const reply=JSON.parse(stdout);const visible=reply.reason || source;
      const files=await fs.readdir(data,{recursive:true});
      const receiptPath=files.find(file=>path.basename(file).startsWith("receipt-"));
      const receipt=receiptPath ? JSON.parse(await fs.readFile(path.join(data,receiptPath),"utf8")) : null;
      const panel=await readLatestPanelDecision(sessionDirectory(data,item.id));
      const eventPath=files.find(file=>path.basename(file)==="events.jsonl");
      const activity=eventPath ? (await fs.readFile(path.join(data,eventPath),"utf8")).trim().split("\n").map(JSON.parse).at(-1) : null;
      const healthPath=files.find(file=>path.basename(file)==="hook-health.json");
      const health=healthPath ? JSON.parse(await fs.readFile(path.join(data,healthPath),"utf8")) : null;
      const requiredLost=receipt?.decisions.filter(row=>row.action==="omit"&&requiredLines.includes(row.number)).map(row=>row.number) || [];
      const actualLost=reply.reason ? requiredLost : [];
      const originals=files.filter(file=>file.startsWith("outputs/")&&file.endsWith(".txt"));
      const originalExact=originals.length ? (await fs.readFile(path.join(data,originals[0]),"utf8"))===projectedSource : null;
      const originalEnvelope=item.metadata&&originals.length ? JSON.parse(await fs.readFile(path.join(data,originals[0].replace(/\.txt$/,".json")),"utf8")) : null;
      const envelopeExact=originalEnvelope ? isDeepStrictEqual(originalEnvelope,event.tool_response) : null;
      const report={id:item.id,expected_kind:item.kind,kind:receipt?.manifest.output_kind || activity?.output_kind || null,
        status:receipt?.manifest.status || health?.last_skip || (item.enabled === false ? "disabled" : "error"),lines:item.lines.length,required:item.required_lines.length,
        calls,relevance_batches:receipt ? receipt.manifest.requests-Number(receipt.manifest.choice_gate_ran) : null,request_budgets:requestBudgets,protocol_failures:protocolFailures,
        elapsed_ms:Date.now()-started,saved_bytes:Buffer.byteLength(source)-Buffer.byteLength(visible),
        required_lost:actualLost,proposed_required_lost:requiredLost,original_exact:originalExact,envelope_exact:envelopeExact,
        panel_rows:panel?.rows.length || 0,panel_matches_receipt:receipt ? panel?.receipt_id===receipt.manifest.id &&
          panel.status===receipt.manifest.status && panel.totals.requests===receipt.manifest.requests : panel===null,
        error:stderr ? health?.last_error || stderr.trim().slice(0,256) : null};
      const complete=receipt && receipt.decisions.filter(row=>row.batch_id!==undefined).length===judged.size && receipt.manifest.lines_unjudged===0;
      if (!report.panel_matches_receipt || (item.fault && (!report.error || receipt || originals.length || files.some(file=>path.basename(file)==="latest-decision.json"))) || protocolFailures.length || (receipt&&!complete) || actualLost.length || (reply.reason&&(originalExact!==true || item.metadata&&envelopeExact!==true)) ||
          (!live&&item.min_batches&&(!receipt||report.relevance_batches<item.min_batches)) ||
          (item.expect_full&&reply.reason) || (item.expected_calls!==undefined&&calls!==item.expected_calls)) {
        report.failed=true;
      }
      const dest=path.join(out,item.id);await fs.mkdir(dest,{recursive:true,mode:0o700});
      for (const file of files.filter(file=>/^(receipt|batch)-/.test(path.basename(file)))) await fs.copyFile(path.join(data,file),path.join(dest,path.basename(file)));
      if (activity) await fs.writeFile(path.join(dest,"activity.json"),JSON.stringify(activity,null,2)+"\n");
      if (receipt) await fs.writeFile(path.join(dest,"reply.json"),JSON.stringify(reply)+"\n");
      if (panel) await fs.writeFile(path.join(dest,"panel.json"),JSON.stringify(panel)+"\n");
      if (receipt) qualityCases.push({id:item.id,split:process.argv.includes("--holdout") || process.argv.includes("--batching") ? "holdout" : "train",
        receipt:`${item.id}/${path.basename(receiptPath)}`,required_lines:requiredLines});
      reports.push(report);console.log(JSON.stringify(report));
    }
    const times=reports.map(item=>item.elapsed_ms).sort((a,b)=>a-b);
    const summary={live,cases:reports.length,calls:totalCalls,input_tokens:inputTokens,output_tokens:outputTokens,
      replaced:reports.filter(item=>item.status==="replace").length,required_lines:reports.reduce((sum,item)=>sum+item.required,0),
      panel_decisions:reports.filter(item=>item.panel_rows>0).length,
      required_lost:reports.reduce((sum,item)=>sum+item.required_lost.length,0),
      failures:reports.filter(item=>item.failed).map(item=>item.id),
      errors:reports.filter(item=>item.error).map(item=>({id:item.id,error:item.error})),
      saved_bytes:reports.reduce((sum,item)=>sum+item.saved_bytes,0),p50_ms:times[Math.floor(times.length*.5)],p95_ms:times[Math.min(times.length-1,Math.floor(times.length*.95))]};
    await fs.writeFile(path.join(out,"report.json"),JSON.stringify({summary,cases:reports},null,2)+"\n");
    if (qualityCases.length) {
      const casesPath=path.join(out,"quality-cases.json");
      await fs.writeFile(casesPath,JSON.stringify(qualityCases,null,2)+"\n");
      const audit=spawnSync(path.join(path.dirname(hook),"jevctl"),["evaluate-quality","--cases",casesPath],{encoding:"utf8",maxBuffer:16000000});
      if (audit.status !== 0) throw new Error(`Quality replay failed: ${audit.stderr || audit.error?.message}`);
      await fs.writeFile(path.join(out,"quality-audit.json"),audit.stdout);
    }
    console.log(JSON.stringify(summary));if(summary.failures.length) process.exitCode=1;
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const resolved=await fs.realpath(temporary);
    if (resolved !== temporary || !(await fs.lstat(temporary)).isDirectory()) throw new Error("Unsafe task cleanup");
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
