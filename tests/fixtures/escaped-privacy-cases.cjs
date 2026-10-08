"use strict";
// Only synthetic sentinels: the escaped spellings must stay local even when a
// protected diagnostic row would otherwise be supplied as provider context.
const escape = value => Array.from(value, char => `\\u${char.charCodeAt(0).toString(16).padStart(4,"0")}`).join("");
const cases=[];
for (const [name,marker] of [
  ["api-key","API_KEY=synthetic-sentinel-only"],
  ["bearer","Bearer synthetic-sentinel-only"],
  ["pem","-----BEGIN PRIVATE KEY-----"],
]) {
  for (const format of ["go","cargo","rg"]) {
    const noise=Array.from({length:80},(_,index)=>format==="go"
      ? JSON.stringify({Action:"run",Package:"synthetic",Test:`routine_${index}`})
      : format==="cargo" ? JSON.stringify({reason:"compiler-artifact",target:{name:`routine_${index}`}})
        : JSON.stringify({type:"match",data:{path:{text:`src/routine_${index}.rs`},lines:{text:"value=1\n"},line_number:index+1}}));
    const record=format==="go" ? {Action:"output",Package:"synthetic",Test:"required",Output:`ERROR ${marker}\n`}
      : format==="cargo" ? {reason:"compiler-message",message:{level:"error",message:marker}}
        : {type:"match",data:{path:{text:"src/required.rs"},lines:{text:`ERROR ${marker}\n`},line_number:37}};
    noise[36]=JSON.stringify(record).replace(marker,escape(marker));
    noise.push(JSON.stringify(format==="go" ? {Action:"pass",Package:"synthetic"}
      : format==="cargo" ? {reason:"build-finished",success:false} : {type:"summary",data:{}}));
    cases.push({id:`escaped-${format}-${name}`,kind:format==="rg"?"independent_matches":"repetitive_log",
      task:"Find the synthetic failure while preserving diagnostics and final completion.",
      command:format==="go"?"go test -json":format==="cargo"?"cargo build --message-format=json":"rg --json value src",
      lines:noise,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
  }
}
const paths=Array.from({length:80},(_,index)=>JSON.stringify({type:"match",data:{path:{text:`src/routine_${index}.rs`},lines:{text:"value=1\n"},line_number:index+1}}));
paths[36]=JSON.stringify({type:"match",data:{path:{text:"config.env"},lines:{text:"value=1\n"},line_number:37}}).replace("config.env",escape("config.env"));
paths.push(JSON.stringify({type:"summary",data:{}}));
cases.push({id:"escaped-rg-environment-path",kind:"independent_matches",task:"Read the configuration path from the match.",command:"rg --json value src",
  lines:paths,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const literal="INFO API\\u005fKEY=synthetic-sentinel-only";
cases.push({id:"escaped-log-literal-marker",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"synthetic-worker",
  lines:[...Array.from({length:80},(_,index)=>`INFO routine poll ${index}`),literal,"ERROR synthetic failure","Done"],required_lines:[81,82,83],
  expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const nested=Array.from({length:80},(_,index)=>JSON.stringify({Action:"run",Package:"synthetic",Test:`routine_${index}`}));
nested[36]=JSON.stringify({Action:"output",Package:"synthetic",Output:literal+"\n"});
nested.push(JSON.stringify({Action:"pass",Package:"synthetic"}));
cases.push({id:"escaped-go-literal-marker",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"go test -json",
  lines:nested,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const colored="INFO API_\x1b[31mKEY=synthetic-sentinel-only\x1b[0m";
cases.push({id:"ansi-log-marker",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"synthetic-worker",
  lines:[...Array.from({length:80},(_,index)=>`INFO routine poll ${index}`),colored,"ERROR synthetic failure","Done"],required_lines:[81,82,83],
  expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const coloredNested=[...nested];
coloredNested[36]=JSON.stringify({Action:"output",Package:"synthetic",Output:colored+"\n"});
cases.push({id:"ansi-go-marker",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"go test -json",
  lines:coloredNested,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const unsupported="\x1b[?25lINFO unsupported ANSI sequence";
cases.push({id:"ansi-log-leading-unsupported",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"synthetic-worker",
  lines:[unsupported,...Array.from({length:80},(_,index)=>`INFO routine poll ${index}`),colored,"ERROR synthetic failure","Done"],required_lines:[82,83,84],
  expect_full:true,expected_calls:0,expected_skip:"sensitive"});
const unsupportedNested=[...nested];
unsupportedNested[36]=JSON.stringify({Action:"output",Package:"synthetic",Output:unsupported+"\n"+colored+"\n"});
cases.push({id:"ansi-go-leading-unsupported",kind:"repetitive_log",task:"Find the synthetic failure and final completion.",command:"go test -json",
  lines:unsupportedNested,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
module.exports=cases;
