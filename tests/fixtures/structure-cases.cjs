"use strict";
// Valid stdout contracts with independent, mandatory stderr diagnostics.
const ids={session_id:"11111111-1111-4111-8111-111111111111"};
const envelope=value=>({content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value});
const foreground=(stdout,stderr)=>({duration_ms:20,exit_code:1,output_truncated:false,stderr,stdout,writable_layer_bytes:4096});
function projection(stdout,stderr) {
  return `Command result metadata: {"duration_ms":20,"exit_code":1,"output_truncated":false,"writable_layer_bytes":4096}\nCommand result stream: stdout\n${stdout}${stdout.endsWith("\n") ? "" : "\n"}Command result stream: stderr\n${stderr}`;
}
const stderr="ERROR: synthetic connection refused at example.invalid:8443\nINFO retained stderr context\n";
const go=Array.from({length:80},(_,index)=>JSON.stringify({Action:"run",Package:"synthetic",Test:`routine_${index}`}));
go.push(JSON.stringify({Action:"pass",Package:"synthetic"}));
const cargo=Array.from({length:80},(_,index)=>JSON.stringify({reason:"compiler-artifact",target:{name:`module_${index}`}}));
cargo.push(JSON.stringify({reason:"build-finished",success:false}));
const numbered=Array.from({length:81},(_,index)=>`src/module_${index}.rs:${index+1}:value=${index+1}`);
const cases=[...[["go","go test -json",go],["cargo","cargo build --message-format=json",cargo],["numbered","rg -n value src",numbered]].map(([id,script,lines])=>({
  id:`lab-${id}-stderr`,kind:id==="numbered"?"independent_matches":"repetitive_log",task:"Identify the failed connection and preserve the final stdout record and stderr diagnostics.",
  command:script,tool:"mcp__lab_control__lab_session_execute",tool_input:{script,...ids},lines,required_lines:[81],extra_required_projected_lines:[85,86],required_offset:2,
  response_factory:source=>envelope(foreground(source,stderr)),projection_factory:source=>projection(source,stderr),expected_decision:true,expected_classification_calls:0,
}))];
const log=[...Array.from({length:60},(_,index)=>`INFO routine background poll ${index}`),"ERROR synthetic failure","Done"];
for (const [id,task] of [["all-filesystems","Find the failure affecting all filesystems."],["every-entrypoint","Find the failing every entrypoint handler."],["output-latency","Report the complete output_latency setting associated with the failure."]]) {
  const rows=[...log];
  if (id==="all-filesystems") rows[60]="ERROR synthetic failure affects filesystems synthetic_root and synthetic_cache";
  if (id==="every-entrypoint") rows[60]="ERROR every entrypoint handler: synthetic failure";
  if (id==="output-latency") rows[30]="INFO observed output_latency=42ms in synthetic worker";
  cases.push({id:`task-${id}-boundary`,kind:"repetitive_log",task,command:"synthetic-worker",lines:rows,required_lines:id==="output-latency"?[31,61,62]:[61,62],expected_decision:true,expected_classification_calls:0});
}
for (const [id,command,row,completion] of [
  ["go","go test -json",'{"Action":"fail","Action":"run","Package":"synthetic","Test":"required"}',JSON.stringify({Action:"pass",Package:"synthetic"})],
  ["cargo","cargo build --message-format=json",'{"reason":"build-finished","reason":"compiler-artifact","success":false}',JSON.stringify({reason:"build-finished",success:true})],
  ["rg","rg --json value src",'{"type":"match","data":{"path":{"text":"src/required.rs","text":"src/routine.rs"},"lines":{"text":"value=1\\n"},"line_number":2}}',JSON.stringify({type:"summary",data:{}})],
]) {
  cases.push({id:`duplicate-${id}-jsonl`,kind:"repetitive_log",task:"Preserve the ambiguous machine output exactly.",command,
    lines:[...Array(25).fill(row),completion],required_lines:Array.from({length:26},(_,index)=>index+1),expect_full:true,expected_calls:0,
    expected_skip:id==="rg"?"sensitive":"structure_guard"});
}
const matches=Array.from({length:80},(_,index)=>JSON.stringify({type:"match",data:{path:{text:"src/example.rs"},lines:{text:"FOO BAR\n"},line_number:index+1,
  absolute_offset:index*8,submatches:[{match:{text:index===35?"BAR":"FOO"},start:index===35?4:0,end:index===35?7:3}]}}));
cases.push({id:"rg-json-submatch-offset",kind:"independent_matches",task:"Find the match whose submatch begins at byte4 and report its source line, absolute byte offset, and exact range.",
  command:"rg --json 'FOO|BAR' src",lines:[JSON.stringify({type:"begin",data:{path:{text:"src/example.rs"}}}),...matches,JSON.stringify({type:"summary",data:{}})],
  required_lines:[37],expected_decision:true,expected_classification_calls:0});
const goNoise=Array.from({length:80},(_,index)=>JSON.stringify({Action:"run",Package:"synthetic",Test:`routine_${index}`}));
const goOutput=Output=>JSON.stringify({Action:"output",Package:"synthetic",Test:"failing",Output});
const goFailure=JSON.stringify({Action:"fail",Package:"synthetic"});
const trace=[goOutput("panic: synthetic failure\nstack backtrace:\n"),...Array.from({length:60},(_,index)=>goOutput(`    synthetic/frame_${index}.go:42\n`)),goFailure];
const panic=[goOutput("panic: synthetic failure\n"),goOutput("\n"),goOutput("goroutine 9 [running]:\n"),...Array.from({length:60},(_,index)=>[
  goOutput(`synthetic.example/frame_${index}(0x1234)\n`),goOutput(`\t/synthetic/frame_${index}.go:42 +0x1a\n`)]).flat(),goFailure];
for (const [id,rows] of [["backtrace",trace],["runtime-panic",panic]]) {
  const required=Array.from({length:rows.length},(_,index)=>81+index);
  cases.push({id:`go-json-${id}`,kind:"repetitive_log",task:"Find the synthetic failure and preserve its full diagnostic trace.",command:"go test -json",
    lines:[...goNoise,...rows],required_lines:required,expected_protected_lines:required,expected_decision:true,expected_classification_calls:0});
}
cases.push({id:"go-json-benchmark-measurements",kind:"repetitive_log",task:"Report the benchmark measurements and final package status.",command:"go test -json",
  lines:[...goNoise,JSON.stringify({Action:"output",Package:"synthetic",Output:"BenchmarkSynthetic-8 100 12.345 ns/op 42 B/op 2 allocs/op\n"}),
    JSON.stringify({Action:"bench",Package:"synthetic",Test:"BenchmarkSynthetic",Elapsed:0.002}),JSON.stringify({Action:"pass",Package:"synthetic",Elapsed:0.003})],
  required_lines:[81,82,83],expected_protected_lines:[81,82,83],expected_decision:true,expected_classification_calls:0});
for (const [id,command,row,completion] of [
  ["go-output-missing","go test -json",{Action:"output",Package:"synthetic"},{Action:"pass",Package:"synthetic"}],
  ["go-output-boolean","go test -json",{Action:"output",Package:"synthetic",Output:true},{Action:"pass",Package:"synthetic"}],
  ["cargo-success-missing","cargo build --message-format=json",{reason:"build-finished"},{reason:"build-finished",success:true}],
  ["cargo-success-string","cargo build --message-format=json",{reason:"build-finished",success:"false"},{reason:"build-finished",success:true}],
]) {
  cases.push({id:`malformed-${id}`,kind:"repetitive_log",task:"Inspect the malformed machine output without guessing its meaning.",command,
    lines:[...Array(25).fill(JSON.stringify(row)),JSON.stringify(completion)],required_lines:Array.from({length:26},(_,index)=>index+1),
    expect_full:true,expected_calls:0,expected_skip:"structure_guard"});
}
for (const [id,command] of [
  ["separated","cargo build --message-format json"],
  ["comma","cargo build --message-format=json,json-diagnostic-short"],
  ["repeated","cargo build --message-format=json --message-format json-diagnostic-rendered-ansi"],
]) {
  const rows=[...cargo];
  rows[35]=JSON.stringify({reason:"compiler-message",message:{level:"note",message:"required compiler context",children:[{level:"help",message:"preserve source hint"}]}});
  rows[36]=JSON.stringify({reason:"compiler-message",message:{level:"help",message:"required resolution hint",spans:[{file_name:"src/example.rs",byte_start:12,byte_end:18}]}});
  cases.push({id:`cargo-json-${id}-diagnostics`,kind:"repetitive_log",task:"Report compiler context, resolution hints, and final build result.",command,
    lines:rows,required_lines:[36,37,81],expected_protected_lines:[36,37,81],expected_decision:true,expected_classification_calls:0});
}
const diagnosticRows=[...cargo];
diagnosticRows[35]=JSON.stringify({reason:"compiler-message",message:{level:"note",message:"required compiler context"}});
diagnosticRows[36]=JSON.stringify({reason:"compiler-message",message:{level:"help",message:"required resolution hint"}});
cases.push({id:"cargo-json-note-help",kind:"repetitive_log",task:"Report compiler context, resolution hints, and final build result.",command:"cargo build --message-format=json",
  lines:diagnosticRows,required_lines:[36,37,81],expected_protected_lines:[36,37,81],expected_decision:true,expected_classification_calls:0});
cases.push({id:"coupled-json-build",kind:"progress_output",task:"Report latency and final build status.",command:"cmake --build build",
  lines:[...Array.from({length:80},(_,index)=>`Building synthetic component ${index}`),"{",'  "latency": 42,','  "routine": "steady"',"}","Build successful"],
  required_lines:[82,85],expected_protected_lines:[81,82,83,84],expect_full:true,expected_calls:0,expected_skip:"structure_guard"});
cases.push({id:"coupled-array-build",kind:"progress_output",task:"Report the synthetic build measurements and status.",command:"cmake --build build",
  lines:[...Array.from({length:80},(_,index)=>`Building synthetic component ${index}`),"[","  42,","  17","]","Build successful"],
  required_lines:[82,83,85],expect_full:true,expected_calls:0,expected_skip:"structure_guard"});
cases.push({id:"coupled-source-excerpt-build",kind:"progress_output",task:"Report the compiler diagnostic and its source excerpt.",command:"cmake --build build",
  lines:[...Array.from({length:80},(_,index)=>`Building synthetic component ${index}`),"ERROR: compiler source excerpt","{",'  "latency":42',"}","Build failed"],
  required_lines:[81,82,83,84,85],expect_full:true,expected_calls:0,expected_skip:"structure_guard"});
cases.push({id:"cmake-percent-progress",kind:"repetitive_log",task:"Report the final build status.",command:"cmake --build build",
  lines:[...Array.from({length:80},(_,index)=>`[ ${index}%] Building CXX object synthetic_${index}.o`),"Build successful"],required_lines:[81],
  expected_decision:true,expected_classification_calls:0});
for(const[id,prefix]of [["ninja-windows-progress","[1/80] Building "],["cmake-windows-progress","[ 42%] Building "],["ninja-ansi-windows-progress","[1/80] \x1b[32mBuilding "]]) {
  cases.push({id,kind:"repetitive_log",task:"Report the final build status.",command:"cmake --build build",
    lines:[...Array.from({length:80},(_,index)=>`${prefix}CXX object C:\\users\\synthetic\\component_${index}.o`),"Build successful"],
    required_lines:[81],expected_decision:true,expected_classification_calls:0});
}
for(const[id,text]of [["ninja-secret-progress",String.raw`[1/80] Building CXX object API\u005fKEY=synthetic-sentinel-only`],
  ["ninja-malformed-json-progress",String.raw`[1/80] {"path":"C:\users\synthetic\component.o"`]]) {
  cases.push({id,kind:"repetitive_log",task:"Report the final build status.",command:"cmake --build build",
    lines:[...Array.from({length:80},(_,index)=>`Building synthetic component ${index}`),text,"Build successful"],required_lines:[81,82],
    expect_full:true,expected_calls:0,expected_skip:"sensitive"});
}
cases.push({id:"pytest-normal-success",kind:"repetitive_log",task:"Report the final test totals.",command:"pytest",
  lines:[...Array.from({length:80},(_,index)=>`test synthetic_case_${index} ... ok`),"80 passed in 0.25s"],required_lines:[81],
  expected_decision:true,expected_classification_calls:0});
const atomicJson=["Building synthetic records",...Array.from({length:80},(_,index)=>JSON.stringify({latency:index===39?42:0,routine:index})),"Build successful"];
cases.push({id:"atomic-json-build-records",kind:"progress_output",task:"Report the nonzero latency record and final build status.",command:"cmake --build build",
  lines:atomicJson,required_lines:[41,82],expected_decision:true,expected_classification_calls:0});
const midStack=[goOutput("main.synthetic(0xc000012345)\n"),goOutput("\t/synthetic/main.go:42 +0x1a\n"),
  JSON.stringify({Action:"output",Package:"synthetic",Test:"unrelated",Output:"INFO normal independent observation\n"}),
  goOutput("goroutine 19 [running]:\n"),goOutput("created by main.synthetic in goroutine 1\n"),goOutput("\t/synthetic/start.go:17 +0x2b\n"),...goNoise,goFailure];
const stackBase={kind:"repetitive_log",task:"Preserve the complete synthetic stack and final status.",command:"go test -json",
  lines:midStack,required_lines:[1,2,4,5,6,midStack.length],expected_protected_lines:[1,2,4,5,6,midStack.length],tool_input:{script:"go test -json",...ids},
  tool:"mcp__lab_control__lab_session_execute",response_factory:source=>envelope(foreground(source,"")),projection_factory:source=>projection(source,""),required_offset:2};
cases.push({...stackBase,id:"go-json-mid-stack-execute",expected_decision:true,expected_classification_calls:0});
const observedStack=source=>{const chunk=text=>({text,bytes_read:Buffer.byteLength(text),next_offset:1024+Buffer.byteLength(text),total_bytes:1024+Buffer.byteLength(text),truncated_at_start:false,has_more:false,reset:false});
  return {...ids,process_id:"22222222-2222-4222-8222-222222222222",running:false,exit_code:1,terminal:true,wait_timed_out:false,duration_ms:20,outcome_reason:"completed",stdout:chunk(source),stderr:chunk("")};};
const observedProjection=source=>{const body=observedStack(source),metadata={...body};for(const name of ["stdout","stderr"]) {const {text,...rest}=metadata[name];metadata[name]=rest;}
  return `Command result metadata: ${JSON.stringify(metadata)}\nCommand result stream: stdout\n${source}\nCommand result stream: stderr\n`;};
cases.push({...stackBase,id:"go-json-mid-stack-wait",tool:"mcp__lab_control__lab_process_wait",tool_input:{...ids,process_id:"22222222-2222-4222-8222-222222222222"},
  response_factory:source=>envelope(observedStack(source)),projection_factory:observedProjection,expect_full:true,expected_calls:0,expected_skip:"structure_guard"});
module.exports=cases;
