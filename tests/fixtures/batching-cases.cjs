"use strict";
// API-budget regressions. Synthetic text only; no copied sessions or keys.
const cases=[];
function add(id,lines,required,extra={}) {
  cases.push({id,kind:"repetitive_log",task:"Identify the cause and final status of this run. Preserve the exact values.",
    command:"printf synthetic-output",lines,required_lines:required,...extra});
}
for (const count of [251,300,400,1000,10000]) {
  const lines=Array.from({length:count},(_,i)=>`INFO routine worker poll completed ${i+1}`);
  lines[Math.floor(count*.42)]="The upstream endpoint example.invalid port 8443 refused the connection.";
  lines[count-1]="Run ended with return value 73.";
  add(`many-lines-${count}`,lines,[Math.floor(count*.42)+1,count],{min_batches:2});
}
for (const [id,text,count] of [["wide-lines","routine "+"x".repeat(3800),40],
  ["unicode-batches","状态 正常 🌍 λ ".repeat(100),80],
  ["escaped-batches",'routine "quoted" \\path\\value\t'.repeat(60),80]]) {
  const lines=Array.from({length:count},(_,i)=>`${text} ${i+1}`);
  lines.push("ERROR: synthetic cause at example.invalid port 8443","Run ended with return value 73.");
  add(id,lines,[count+1,count+2],{min_batches:2});
}
const crlf=Array.from({length:450},(_,i)=>`\x1b[32mINFO routine poll ${i+1}\x1b[0m`);
crlf[190]="\x1b[31mERROR: upstream port 8443 refused the connection\x1b[0m";
crlf.push("Run ended with return value 73.");
add("crlf-ansi-batches",crlf,[191,451],{newline:"\r\n",terminated:false,min_batches:2});
add("unpackable-task-context",Array(80).fill("routine line"),[80],
  {command:"printf "+"x".repeat(64000),tool:"mcp__files__inspect",allow_mcp_replacement:true,
    expect_full:true,expected_calls:1,expected_classification_calls:1,expected_relevance_calls:0,
    expected_skip:"relevance_budget"});
module.exports=cases;
