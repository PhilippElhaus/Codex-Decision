"use strict";
// Additional labels chosen before the final live evaluation.
const cases=[];
const noise=n=>Array.from({length:n},(_,i)=>`INFO completed background check ${i+1}; normal operation`);
const add=(id,kind,task,lines,required,extra={})=>cases.push({id,kind,task,lines,required_lines:required,command:"printf synthetic-holdout",split:"holdout",...extra});
for (const index of [4,29,68,101]) {
  const lines=[...noise(120),"run complete"];
  lines[index]="root cause: resolver returned NXDOMAIN for example.invalid";
  lines[index+1]="observed status: connection unavailable on port 8443";
  add(`sparse-cause-${index}`,"repetitive_log","Find the cause of the unavailable connection and its port.",lines,[index+1,index+2,121]);
}
const lines=[...noise(120),"comparison complete"];
lines[39]="expected count = 6000";lines[40]="actual count = 5998";
add("unprotected-exact-values","repetitive_log","Compare expected and actual counts and give their exact difference.",lines,[40,41,121]);
const topology=[...noise(70),"scan complete"];
topology[17]="primary endpoint: host-a.example.invalid port 8443";
topology[18]="fallback endpoint: host-b.example.invalid port 9443";
add("two-required-endpoints","repetitive_log","Identify BOTH primary and fallback endpoint hostnames and ports.",topology,[18,19,71]);
const rare=[...noise(100),"analysis complete"];
rare[49]="record 7341: lost_packets = 17 out of 9000";
add("numeric-evidence","repetitive_log","Find the record with packet loss and report the numerator and denominator.",rare,[50,101]);
const warnings=[...noise(80),"run complete"];
warnings[19]="WARN dependency old_module is deprecated";
warnings[39]="ERROR module expected-value = 93; observed-value = 91";
add("warning-and-failure","repetitive_log","Report all warnings and the cause and exact values of the failure.",warnings,[20,40,81]);
const paths=Array.from({length:100},(_,i)=>`docs/background/topic_${i}.md`);
paths[39]="src/active/routes/network_timeout.rs";paths[69]="src/active/routes/retry_timeout.rs";
add("two-search-matches","independent_records","Find both source files that define network timeout handling.",paths,[40,70],{command:"find src -type f"});
add("every-search-path","exact_content","I need every path in this result verbatim, including documentation paths.",paths,paths.map((_,i)=>i+1),{expect_full:true,command:"find src -type f"});
const unique=Array.from({length:80},(_,i)=>`record ${i}: delay_ms=${10+i}; samples=${900+i}`);
add("all-distinct-values","exact_content","Calculate exact minimum, maximum, median and mean from ALL these values.",unique,unique.map((_,i)=>i+1),{expect_full:true});
add("exact-repetitive-file","exact_content","Print this file EXACTLY byte for byte, including every repeated line.",Array(90).fill("identical configuration row"),Array.from({length:90},(_,i)=>i+1),{expect_full:true,command:"cat synthetic.conf"});
const mixed=[...noise(40),"The following explanation qualifies the results above.","A successful check does not establish the absence of a race.","Its ordering determines whether retries duplicate a request.",...noise(40),"finished"];
add("mixed-explanation","mixed_or_unknown","Explain the race and preserve the complete qualification, not just log status.",mixed,[41,42,43,84],{expect_full:true});
add("unicode-values","repetitive_log","Report the exact Greek name and the two Japanese measurement values.",
  [...noise(50),"計測 α: 期待=6000 実測=5998","終了"],[51,52]);
add("json-like-independent-lines","structured_payload","Read the complete payload and preserve every object.",
  Array.from({length:60},(_,i)=>JSON.stringify({record:i,result:"distinct-value-"+i})),Array.from({length:60},(_,i)=>i+1),{expect_full:true});
add("near-target-limit","progress_output","Confirm whether the build finished.",
  [...Array.from({length:248},(_,i)=>`[${i+1}/248] Compiling component_${i} ... done`),"Build successful"],[249],{command:"cargo build"});
add("progress-253-lines","progress_output","Confirm whether the build finished.",
  [...Array.from({length:252},(_,i)=>`[${i+1}/252] Compiling component_${i} ... done`),"Build successful"],[253],{command:"cargo build",min_batches:2});
add("no-transcript","repetitive_log","Find the failure.",[...noise(80),"ERROR: synthetic failure","Done"],[81,82],{no_transcript:true,expect_full:true});
add("monitor-preview","repetitive_log","Find the failure.",[...noise(80),"ERROR: synthetic failure","Done"],[81,82],{mode:"observe",expect_full:true});
module.exports=cases;
