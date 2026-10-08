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
const precision = require("../tests/fixtures/precision-cases.cjs");
const precisionHoldout = require("../tests/fixtures/precision-holdout.cjs");
const { provider: providerSpec } = require("../vscode-control/providers");
const { readApiKey, sessionDirectory } = require("../vscode-control/core");
const { readLatestPanelDecision } = require("../vscode-control/panel-state");
const { requireProxyHook, auditRun } = require("./two_stage_audit.cjs");
const kinds = ["repetitive_log", "progress_output", "independent_matches", "independent_records", "exact_content", "prose", "structured_payload", "mixed_or_unknown"];
const faults = ["choice-missing", "choice-extra", "choice-sum", "choice-argmax", "choice-class", "choice-confidence", "choice-type", "choice-model", "choice-json", "choice-http401", "choice-http429", "choice-http529", "choice-timeout", "line-missing", "line-extra", "line-type", "line-range", "line-confidence", "line-json", "line-http500", "line-timeout", "line-oversized"];
faults.push("line-late-missing", "line-late-extra", "line-late-http422", "line-late-http500", "line-late-timeout");
faults.push("choice-duplicate-model", "line-duplicate-probability", "line-duplicate-id", "line-late-duplicate-id");
faults.push("choice-trickle", "line-trickle", "line-late-trickle");
const arg = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;
async function main() {
  const live = process.argv.includes("--live");
  const provider = arg("--provider", "openai");
  const spec = providerSpec(provider);
  const providerFaults = provider === "openai" ? ["line-refusal", "line-order", "line-name", "choice-duplicate-option"] : [];
  if (live && !process.argv.includes("--data-dir")) throw new Error("Live mode requires --data-dir; the saved key stays in memory.");
  const hook = path.resolve(arg("--hook", path.join(os.homedir(), ".cache/codex-decision/cargo-target/debug/decision-hook")));
  const hookDetails = await fs.stat(hook);
  if (!hookDetails.isFile() || hookDetails.size > 128 * 1024 * 1024) throw new Error("Invalid testing hook executable");
  requireProxyHook(await fs.readFile(hook));
  const key = live ? await readApiKey(arg("--data-dir"), provider) : null;
  const out = path.resolve(arg("--out", `.local/two-stage/${live ? "live" : "offline"}-${Date.now()}`));
  const maxCalls = Number(arg("--max-calls", "120"));
  const maxTokens = Number(arg("--max-tokens", "500000"));
  const relevantMax = Number(arg("--relevance-max", "5"));
  if (!Number.isInteger(relevantMax) || relevantMax < 0 || relevantMax > 100) throw new Error("Relevance cutoff must be an integer from 0 to 100");
  if (![maxCalls,maxTokens].every(value=>Number.isInteger(value)&&value>0)) throw new Error("Evaluation budgets must be positive integers");
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "decision-two-stage-"));
  if (temporary.startsWith("/mnt/d/")) throw new Error("Temporary work must be off D:");
  let current, calls = 0, totalCalls = 0, forwardedCalls = 0, inputTokens = 0, outputTokens = 0, abortReason = null;
  const reports = [];
  const remoteTimes = [];
  const qualityCases = [];
  let judged = new Set(), requestBudgets = [], protocolFailures = [], stages = [];
  const server = http.createServer(async (req, res) => {
    calls += 1; totalCalls += 1;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes + 4096 > 64000) throw new Error("request limit"); chunks.push(chunk); }
      const wire = JSON.parse(Buffer.concat(chunks));
      const request = Array.isArray(wire.questions) ? { model: wire.model, state: JSON.parse(wire.input),
        questions: Object.fromEntries(wire.questions.map(q => [q.name, { type: q.type === "predicate" ? "noul" : q.type,
          instructions: q.instructions, ...(q.choices ? {criteria: Object.fromEntries(q.choices.map(c => [c.value,c.description]))} : {}) }])) } : wire;
      const encodeResponse = body => {
        if (provider === "typesafe") return body;
        return { ...body, model: body.model === "jev-1.13.0" ? spec.model : body.model,
          answers: Object.entries(body.answers).map(([name,a]) => {
            if (a.type === "noul") { const {noul,type,...other}=a; return {name,type:"predicate",probability:noul,...other}; }
            if (a.type === "choice") return {name,...a,probabilities:Object.entries(a.probabilities).map(([value,probability])=>({value,probability}))};
            return {name,...a};
          }) };
      };
      const first = !!request.questions.output_kind;
      stages.push(first ? "classification" : "relevance");
      const caseId=current.id;
      const stage=calls;
      const budget={state_longest_question_bound:Buffer.byteLength(JSON.stringify(wire.input ?? wire.state))+
        Math.max(...Object.values(wire.questions).map(question=>Buffer.byteLength(JSON.stringify(question))))+4096,
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
        const remoteStarted = Date.now();
        forwardedCalls += 1;
        const response = await fetch(spec.endpoint, { method: "POST",
          headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"},
          body: JSON.stringify(wire), signal: AbortSignal.timeout(10000) });
        const text = await response.text();
        remoteTimes.push(Date.now() - remoteStarted);
        const dest = path.join(out,caseId);await fs.mkdir(dest,{recursive:true,mode:0o700});
        await fs.writeFile(path.join(dest,`remote-call-${stage}.json`), JSON.stringify({request:wire,status:response.status,response:JSON.parse(text)},null,2)+"\n");
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
        if (suffix === "trickle") {
          const encoded=JSON.stringify(encodeResponse(body));let offset=0;
          res.setHeader("Content-Type","application/json");res.write(encoded.slice(0,1));offset=1;
          const timer=setInterval(()=>{
            if (offset>=encoded.length) {clearInterval(timer);res.end();return;}
            res.write(encoded.slice(offset,offset+32));offset+=32;
          },40);
          res.on("close",()=>clearInterval(timer));return;
        }
        if (suffix.startsWith("http")) {res.writeHead(Number(suffix.slice(4)));res.end("{}");return;}
        if (suffix === "json") {res.end("{broken");return;}
        if (suffix === "oversized") {res.end("x".repeat(1000001));return;}
        const id = Object.keys(body.answers)[0];
        if (["refusal", "order", "name", "duplicate-option"].includes(suffix)) {
          const invalid = encodeResponse(body);
          if (suffix === "refusal") invalid.answers[0] = {name:invalid.answers[0].name,type:"refusal"};
          if (suffix === "order") invalid.answers.reverse();
          if (suffix === "name") invalid.answers[0].name = "unexpected";
          if (suffix === "duplicate-option") invalid.answers[0].probabilities[1] = invalid.answers[0].probabilities[0];
          res.end(JSON.stringify(invalid));return;
        }
        if (suffix.startsWith("duplicate-")) {
          let encoded = JSON.stringify(encodeResponse(body));
          if (suffix === "duplicate-model") encoded = encoded.replace('"model":', '"model":"other-model","model":');
          if (suffix === "duplicate-probability") encoded = encoded.replace(provider === "openai" ? '"probability":' : '"noul":', provider === "openai" ? '"probability":0.99,"probability":' : '"noul":0.99,"noul":');
          if (suffix === "duplicate-id") {
            const original = JSON.stringify(id) + ":" + JSON.stringify(body.answers[id]);
            encoded = provider === "openai" ? encoded.replace('"name":'+JSON.stringify(id), '"name":"wrong","name":'+JSON.stringify(id)) : encoded.replace(original, JSON.stringify(id) + ': {"type":"noul","noul":0.99},' + original);
          }
          res.end(encoded);return;
        }
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
      res.setHeader("Content-Type","application/json");res.end(JSON.stringify(encodeResponse(body)));
    } catch { if (!res.headersSent) res.writeHead(502);res.end("{}"); }
  });
  try {
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    let selected = process.argv.includes("--precision-holdout") ? precisionHoldout : process.argv.includes("--precision") ? precision : process.argv.includes("--batching") ? batching : process.argv.includes("--holdout") ? holdout : fixtures;
    if (!live && !process.argv.includes("--skip-faults")) selected = [...selected,
      ...[...faults, ...providerFaults].map(fault => {
        const fixture=fixtures.find(item => item.id === "log-failure-240");
        return {...fixture, id:fault, fault, expect_full:true, expected_calls:fault.startsWith("line-late-") ? 3 : 1,
          expected_classification_calls:Number(fault.startsWith("choice-")), expected_relevance_calls:fault.startsWith("choice-") ? 0 : fault.startsWith("line-late-") ? 3 : 1,
          lines:fault.startsWith("choice-") ? fixture.lines.map(line=>line.replace(/^INFO /,"Routine ")) : fixture.lines};
      })];
    selected = selected.filter(item => !process.argv.includes("--case") || arg("--case").split(",").includes(item.id));
    if (!selected.length) throw new Error("No matching case");
    for (const item of selected) {
      current = item;calls = 0;judged = new Set();requestBudgets=[];protocolFailures=[];stages=[];
      const data = path.join(temporary,item.id);await fs.mkdir(data,{mode:0o700});
      await fs.writeFile(path.join(data,".env"),`${spec.keyName}=synthetic-proxy-key\n`,{mode:0o600});
      await fs.writeFile(path.join(data,"config.json"),item.config_raw || JSON.stringify({schema_version:5,provider,scope:"global",enabled:item.enabled !== false,
        mode:item.mode || "replace",model:spec.model,timeout_seconds:/timeout$|trickle$/.test(item.fault || "") ? .15 : 4,
        allow_mcp_replacement:!!item.allow_mcp_replacement,
        relevance_policy:{relevant_max:relevantMax}}),{mode:0o600});
      const transcript=path.join(data,"transcript.jsonl");
      const userRecord = content => JSON.stringify({type:"response_item",payload:{role:"user",content}})+"\n";
      await fs.writeFile(transcript,(item.prior_task ? userRecord([{type:"input_text",text:item.prior_task}]) : "")+
        userRecord(item.latest_content || [{type:"input_text",text:item.task}]));
      const newline=item.newline || "\n";
      const source=item.lines.join(newline)+(item.terminated === false ? "" : newline);
      const projectedSource=item.projection_factory ? item.projection_factory(source) : item.metadata ? 'Command result metadata: {"exit_code":1}\n'+source : source;
      const requiredOffset=item.required_offset ?? Number(!!item.metadata);
      const requiredLines=item.required_lines.map(number=>number+requiredOffset);
      current.sourceLines=projectedSource.split(/\r?\n/).filter((_,index,all)=>index!==all.length-1||all[index]!=="");
      current.requiredLines=requiredLines;
      const event={hook_event_name:"PostToolUse",tool_name:item.tool || "Bash",session_id:item.id,tool_use_id:"synthetic-call",transcript_path:transcript,
        tool_input:item.tool_input || {command:item.command},tool_response:item.response_factory ? item.response_factory(source) : item.metadata ? {output:source,exit_code:1} : source};
      if (item.no_transcript) delete event.transcript_path;
      const started=Date.now();
      const child=spawn(hook,[],{env:{...process.env,PLUGIN_DATA:data,CODEX_DECISION_TEST_ENDPOINT:`http://127.0.0.1:${server.address().port}/`},stdio:["pipe","pipe","pipe"]});
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
      const statsPath=files.find(file=>path.basename(file)==="stats.json");
      const stats=statsPath ? JSON.parse(await fs.readFile(path.join(data,statsPath),"utf8")) : null;
      const requiredLost=receipt?.decisions.filter(row=>row.action==="omit"&&requiredLines.includes(row.number)).map(row=>row.number) || [];
      const actualLost=reply.reason ? requiredLost : [];
      const routine = new Set((item.routine_lines || []).map(number => number + requiredOffset));
      const labeled = receipt?.decisions.filter(row => typeof row.p_task_relevant === "number" &&
        (routine.has(row.number) || requiredLines.includes(row.number))) || [];
      const routineKept = labeled.filter(row => routine.has(row.number) && row.action !== "omit").length;
      const originals=files.filter(file=>file.startsWith("outputs/")&&file.endsWith(".txt"));
      const originalExact=originals.length ? (await fs.readFile(path.join(data,originals[0]),"utf8"))===projectedSource : null;
      const typedEnvelope=typeof event.tool_response!=="string";
      const originalEnvelope=typedEnvelope&&originals.length ? JSON.parse(await fs.readFile(path.join(data,originals[0].replace(/\.txt$/,".json")),"utf8")) : null;
      const envelopeExact=originalEnvelope ? isDeepStrictEqual(originalEnvelope,event.tool_response) : null;
      const report={id:item.id,expected_kind:item.kind,kind:receipt?.manifest.output_kind || activity?.output_kind || null,
        status:receipt?.manifest.status || health?.last_skip || (item.enabled === false ? "disabled" : "error"),lines:item.lines.length,required:item.required_lines.length,
        calls,relevance_batches:receipt ? receipt.manifest.requests-Number(receipt.manifest.choice_gate_ran) : null,request_budgets:requestBudgets,protocol_failures:protocolFailures,
        elapsed_ms:Date.now()-started,saved_bytes:Buffer.byteLength(source)-Buffer.byteLength(visible),
        required_lost:actualLost,proposed_required_lost:requiredLost,original_exact:originalExact,envelope_exact:envelopeExact,
        labeled_judgments:labeled.length,routine_kept:routineKept,
        panel_rows:panel?.rows.length || 0,panel_matches_receipt:receipt ? panel?.receipt_id===receipt.manifest.id &&
          panel.status===receipt.manifest.status && panel.totals.requests===receipt.manifest.requests : panel===null,
        error:health?.last_error || (stderr ? stderr.trim().slice(0,256) : null)};
      const audit = auditRun({ item, calls, stages, receipt, health, stats, activity, error:report.error, replaced:!!reply.reason, live });
      Object.assign(report, { outcome:audit.outcome, recorded_requests:audit.recorded_requests,
        classification_attempts:audit.classification_attempts, relevance_attempts:audit.relevance_attempts, audit_failures:audit.failures });
      const complete=receipt && receipt.decisions.filter(row=>row.batch_id!==undefined).length===judged.size && receipt.manifest.lines_unjudged===0;
      if (audit.failures.length || !report.panel_matches_receipt || (item.fault && (!report.error || receipt || originals.length || files.some(file=>path.basename(file)==="latest-decision.json"))) || protocolFailures.length || (receipt&&!complete) || actualLost.length || (reply.reason&&(originalExact!==true || typedEnvelope&&envelopeExact!==true)) ||
          (!live&&item.min_batches&&(!receipt||report.relevance_batches<item.min_batches)) ||
          (item.expect_full&&reply.reason) || (item.expected_calls!==undefined&&calls!==item.expected_calls)) {
        report.failed=true;
      }
      const dest=path.join(out,item.id);await fs.mkdir(dest,{recursive:true,mode:0o700});
      for (const file of files.filter(file=>/^(receipt|batch)-/.test(path.basename(file)))) await fs.copyFile(path.join(data,file),path.join(dest,path.basename(file)));
      if (activity) await fs.writeFile(path.join(dest,"activity.json"),JSON.stringify(activity,null,2)+"\n");
      if (health) await fs.writeFile(path.join(dest,"hook-health.json"),JSON.stringify(health,null,2)+"\n");
      if (stats) await fs.writeFile(path.join(dest,"stats.json"),JSON.stringify(stats,null,2)+"\n");
      await fs.writeFile(path.join(dest,"reply.json"),JSON.stringify(reply)+"\n");
      if (panel) await fs.writeFile(path.join(dest,"panel.json"),JSON.stringify(panel)+"\n");
      if (receipt) qualityCases.push({id:item.id,split:process.argv.includes("--holdout") || process.argv.includes("--batching") || process.argv.includes("--precision-holdout") ? "holdout" : "train",
        receipt:`${item.id}/${path.basename(receiptPath)}`,required_lines:requiredLines});
      reports.push(report);console.log(JSON.stringify(report));
      if (audit.abort) { abortReason = audit.abort; break; }
    }
    const times=reports.map(item=>item.elapsed_ms).sort((a,b)=>a-b);
    remoteTimes.sort((a,b)=>a-b);
    const calledTimes=reports.filter(item=>item.calls>0).map(item=>item.elapsed_ms).sort((a,b)=>a-b);
    const percentile=(values,p)=>values.length ? values[Math.min(values.length-1,Math.floor(values.length*p))] : null;
    const summary={live,provider,model:spec.model,api_calls:forwardedCalls,completed_api_calls:remoteTimes.length,api_p50_ms:percentile(remoteTimes,.5),api_p95_ms:percentile(remoteTimes,.95),called_output_p50_ms:percentile(calledTimes,.5),called_output_p95_ms:percentile(calledTimes,.95),cases:reports.length,calls:totalCalls,input_tokens:inputTokens,output_tokens:outputTokens,
      aborted:abortReason, recorded_requests:reports.reduce((sum,item)=>sum+item.recorded_requests,0),
      classification_attempts:reports.reduce((sum,item)=>sum+item.classification_attempts,0), relevance_attempts:reports.reduce((sum,item)=>sum+item.relevance_attempts,0),
      outcomes:reports.reduce((counts,item)=>{counts[item.outcome]=(counts[item.outcome] || 0)+1;return counts;},{}),
      replaced:reports.filter(item=>item.status==="replace").length,required_lines:reports.reduce((sum,item)=>sum+item.required,0),
      panel_decisions:reports.filter(item=>item.panel_rows>0).length,
      required_lost:reports.reduce((sum,item)=>sum+item.required_lost.length,0),
      labeled_judgments:reports.reduce((sum,item)=>sum+item.labeled_judgments,0),
      routine_kept:reports.reduce((sum,item)=>sum+item.routine_kept,0),
      failures:reports.filter(item=>item.failed).map(item=>item.id),
      errors:reports.filter(item=>item.error).map(item=>({id:item.id,error:item.error})),
      saved_bytes:reports.reduce((sum,item)=>sum+item.saved_bytes,0),p50_ms:times[Math.floor(times.length*.5)],p95_ms:times[Math.min(times.length-1,Math.floor(times.length*.95))]};
    await fs.writeFile(path.join(out,"report.json"),JSON.stringify({summary,cases:reports},null,2)+"\n");
    if (qualityCases.length) {
      const casesPath=path.join(out,"quality-cases.json");
      await fs.writeFile(casesPath,JSON.stringify(qualityCases,null,2)+"\n");
      const audit=spawnSync(path.join(path.dirname(hook),"decisionctl"),["evaluate-quality","--cases",casesPath],{encoding:"utf8",maxBuffer:16000000});
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
