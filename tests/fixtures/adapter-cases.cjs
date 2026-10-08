"use strict";
// Exact public command contracts with reviewed dummy logs and metadata.
const lines = [...Array.from({length:80},(_,index)=>`INFO routine worker heartbeat ${index}`),
  "ERROR: synthetic connection refused at example.invalid:8443", "Done"];
const ids = { session_id:"11111111-1111-4111-8111-111111111111", process_id:"22222222-2222-4222-8222-222222222222" };
const chunk = text => ({bytes_read:Buffer.byteLength(text),has_more:false,next_offset:Buffer.byteLength(text),reset:false,
  text,total_bytes:Buffer.byteLength(text),truncated_at_start:false});
const foreground = source => ({duration_ms:20,exit_code:1,output_truncated:false,stderr:"",stdout:source,writable_layer_bytes:4096});
const observation = source => ({duration_ms:20,exit_code:1,outcome_reason:"completed",...ids,running:false,
  stderr:chunk(""),stdout:chunk(source),terminal:true,wait_timed_out:false});
const envelope = value => ({content:[{type:"text",text:JSON.stringify(value)}],isError:false,structuredContent:value});
function projected(payload) {
  const metadata={};
  for (const name of Object.keys(payload).sort()) {
    if (["stdout","stderr"].includes(name)) {
      if (typeof payload[name]==="object") metadata[name]=Object.fromEntries(Object.entries(payload[name]).filter(([name])=>name!=="text"));
    } else metadata[name]=payload[name];
  }
  const stdout=typeof payload.stdout==="string" ? payload.stdout : payload.stdout.text;
  const stderr=typeof payload.stderr==="string" ? payload.stderr : payload.stderr.text;
  return `Command result metadata: ${JSON.stringify(metadata)}\nCommand result stream: stdout\n${stdout}${stdout.endsWith("\n") ? "" : "\n"}Command result stream: stderr\n${stderr}`;
}
const base = {kind:"repetitive_log",task:"Find the connection failure and preserve its exact port and final status.",
  command:"node synthetic-worker.cjs",lines,required_lines:[81,82],expected_classification_calls:0};
const labBase = {...base,tool:"mcp__lab_control__lab_session_execute",tool_input:{script:"node synthetic-worker.cjs",...ids},
  response_factory:source=>envelope(foreground(source)),projection_factory:source=>projected(foreground(source)),required_offset:2};
const cases = [
  {...base,id:"polling-command-result",tool:"write_stdin",tool_input:{session_id:12,chars:""},metadata:true,expected_decision:true},
  {...base,id:"polling-input-write",tool:"write_stdin",tool_input:{session_id:12,chars:"x"},metadata:true,expect_full:true,expected_calls:0,expected_skip:"unsupported_route"},
  {...base,id:"namespace-source-read",tool:"functions.read_file",tool_input:{path:"Config"},expect_full:true,expected_calls:0,expected_skip:"exact_content"},
  {...base,id:"environment-reference-log",lines:[...Array.from({length:80},()=>"INFO checked reference (process.env.ACCESS_TOKEN);"),...lines.slice(-2)],
    command:"node -e 'void(process.env.CLIENT_SECRET);'",expected_calls:1,expected_decision:true},
  {...base,id:"environment-reference-assignment",command:"node -e 'process.env.ACCESS_TOKEN=synthetic-sentinel;'",
    expect_full:true,expected_calls:0,expected_skip:"sensitive"},
  {...base,id:"environment-reference-path",tool_input:{command:base.command,path:"process.env.CLIENT_SECRET"},
    expect_full:true,expected_calls:0,expected_skip:"sensitive"},
  {...labBase,id:"lab-execute-supported",expected_decision:true},
  {...labBase,id:"lab-execute-monitor",mode:"observe",expect_full:true,expected_decision:true},
  {...labBase,id:"lab-execute-replace",allow_mcp_replacement:true,expected_decision:true},
  {...labBase,id:"lab-wait-supported",tool:"mcp__lab_control__lab_process_wait",tool_input:ids,
    response_factory:source=>envelope(observation(source)),projection_factory:source=>projected(observation(source)),expected_decision:true},
  {...labBase,id:"lab-native-alias-supported",tool:"functions.mcp__lab_control__lab_session_execute",expected_decision:true},
  {...labBase,id:"lab-native-enabled-off",enabled:false,expect_full:true,expected_calls:0},
  {...labBase,id:"lab-native-plain-string",response_factory:source=>source,projection_factory:undefined,required_offset:0,
    expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"},
  {...labBase,id:"lab-native-prose",kind:"prose",lines:Array.from({length:30},(_,index)=>`Paragraph ${index}: this explanation qualifies the preceding observation and requires the following conclusion.`),
    required_lines:Array.from({length:30},(_,index)=>index+1),expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"},
  {...labBase,id:"lab-wrapper-log",tool:"exec",tool_input:{input:"text(await tools.mcp__lab_control__lab_session_execute(dummy))"},
    response_factory:source=>[{type:"input_text",text:JSON.stringify(envelope(foreground(source)))}],expected_decision:true},
  {...labBase,id:"lab-wrapper-raw-execute",tool:"exec",tool_input:{input:"text(dummy.structuredContent)"},
    response_factory:source=>[{type:"input_text",text:JSON.stringify(foreground(source))}],expected_decision:true},
  {...labBase,id:"lab-wrapper-raw-wait",tool:"wait",tool_input:{cell_id:"synthetic"},
    response_factory:source=>[{type:"input_text",text:JSON.stringify(observation(source))}],projection_factory:source=>projected(observation(source)),expected_decision:true},
  {...labBase,id:"lab-source-read",tool_input:{script:"cat Config",...ids},expect_full:true,expected_calls:0,expected_skip:"exact_content"},
];
const ninjaLines=[...Array.from({length:80},(_,index)=>`[${index+1}/80] Building CXX object C:\\users\\synthetic\\component_${index}.o`),"Build successful"];
const ninjaBase={...labBase,lines:ninjaLines,required_lines:[81],task:"Report the final build status."};
cases.push({...ninjaBase,id:"lab-wait-ninja-progress",tool:"mcp__lab_control__lab_process_wait",tool_input:ids,
  response_factory:source=>envelope(observation(source)),projection_factory:source=>projected(observation(source)),expected_decision:true});
cases.push({...ninjaBase,id:"lab-wrapped-wait-ninja-progress",tool:"wait",tool_input:{cell_id:"synthetic"},
  response_factory:source=>[{type:"input_text",text:JSON.stringify(observation(source))}],projection_factory:source=>projected(observation(source)),expected_decision:true});
cases.push({...ninjaBase,id:"lab-wait-ninja-invalid-status",tool:"mcp__lab_control__lab_process_wait",tool_input:ids,
  response_factory:source=>envelope({...observation(source),running:true,exit_code:7,terminal:true}),
  expect_full:true,expected_calls:0,expected_skip:"unsupported_result"});
cases.push({...ninjaBase,id:"lab-wait-ninja-mixed-prose",tool:"mcp__lab_control__lab_process_wait",tool_input:ids,
  lines:[...ninjaLines,"This paragraph qualifies the ordering of these build observations.","Its ordering is needed to explain these observations.","The final interpretation requires preserving the preceding qualifications."],required_lines:[81,82,83,84],
  response_factory:source=>envelope(observation(source)),projection_factory:source=>projected(observation(source)),
  expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"});
cases.push({...base,id:"generic-mcp-ninja-disabled",tool:"mcp__synthetic__read_log",tool_input:{},command:"",lines:ninjaLines,
  task:"Report the final build status.",required_lines:[81],expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"});
for (const [id, state, valid] of [
  ["lab-wait-running",{running:true,exit_code:-1,terminal:false,wait_timed_out:true},true],
  ["lab-wait-unknown",{running:false,exit_code:-1,terminal:false,wait_timed_out:false},true],
  ["lab-wait-contradictory",{running:true,exit_code:7,terminal:true,wait_timed_out:false},false],
  ["lab-wait-terminal-timeout",{running:false,exit_code:7,terminal:true,wait_timed_out:true},false],
]) {
  const payload=source=>({...observation(source),...state});
  cases.push({...labBase,id,tool:"mcp__lab_control__lab_process_wait",tool_input:ids,
    response_factory:source=>envelope(payload(source)),projection_factory:source=>projected(payload(source)),
    ...(valid?{expected_decision:true}:{expect_full:true,expected_calls:0,expected_skip:"unsupported_result"})});
}
for (const [id, change] of [
  ["lab-mixed-media",body=>{body.content.push({type:"image",data:"synthetic"});}],
  ["lab-unknown-envelope",body=>{body.structuredContent.unknown="required";body.content[0].text=JSON.stringify(body.structuredContent);}],
  ["lab-structured-mismatch",body=>{body.structuredContent.stdout="different";}],
  ["lab-truncated-result",body=>{body.structuredContent.output_truncated=true;body.content[0].text=JSON.stringify(body.structuredContent);}],
]) cases.push({...labBase,id,expect_full:true,expected_calls:0,expected_skip:"unsupported_result",
  response_factory:source=>{const body=envelope(foreground(source));change(body);return body;}});
module.exports = cases;
