"use strict";
const {spawn}=require("node:child_process");
const assert=require("node:assert/strict");
const children=new Set();

function start(hook,data,endpoint,event,extra={}) {
  const started=process.hrtime.bigint();
  const child=spawn(hook,[],{env:{...process.env,PLUGIN_DATA:data,CODEX_DECISION_TEST_ENDPOINT:endpoint,...extra},stdio:["pipe","pipe","pipe"]});
  children.add(child);
  const done=new Promise((resolve,reject)=>{
    let stdout="",stderr="";
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Owned stress hook exceeded 55 seconds"));},55000);
    child.on("error",error=>{clearTimeout(timer);reject(error);});
    child.stdout.on("data",chunk=>stdout+=chunk);child.stderr.on("data",chunk=>stderr+=chunk);
    child.stdin.on("error",error=>{if(error.code!=="EPIPE")reject(error);});
    child.on("close",(code,signal)=>{
      children.delete(child);clearTimeout(timer);
      resolve({code,signal,stdout,stderr,elapsedMs:Number(process.hrtime.bigint()-started)/1000000});
    });
  });
  child.stdin.end(JSON.stringify(event));
  return {child,done};
}

async function invoke(hook,data,endpoint,event) {
  const result=await start(hook,data,endpoint,event).done;
  assert.equal(result.code,0,result.stderr);
  return {...result,reply:JSON.parse(result.stdout)};
}

async function stopOwned() {
  await Promise.all([...children].map(child=>new Promise(resolve=>{child.once("close",resolve);child.kill("SIGKILL");})));
}

module.exports={start,invoke,stopOwned,ownedPids:()=>[...children].map(child=>child.pid)};
