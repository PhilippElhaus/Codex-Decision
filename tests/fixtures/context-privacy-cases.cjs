"use strict";
const log=[...Array.from({length:80},(_,index)=>`INFO routine background poll ${index}`),"ERROR synthetic failure","Done"];
const task="Find the synthetic failure and final completion.";
const base={kind:"repetitive_log",task,command:"synthetic-worker",lines:log,required_lines:[81,82],expected_classification_calls:0};
const cases=[
  {...base,id:"escaped-command-marker",command:String.raw`synthetic-worker '--API\u005fKEY=synthetic-sentinel-only'`,expect_full:true,expected_calls:0,expected_skip:"sensitive"},
  {...base,id:"ansi-command-marker",command:"synthetic-worker '--API_\x1b[31mKEY=synthetic-sentinel-only\x1b[0m'",expect_full:true,expected_calls:0,expected_skip:"sensitive"},
  {...base,id:"escaped-task-marker",task:String.raw`Find the failure. API\u005fKEY=synthetic-sentinel-only`,expect_full:true,expected_calls:0,expected_skip:"unsafe_task_context"},
  {...base,id:"normalized-task-marker",task:"Find the failure. Bearer\tsynthetic-sentinel-only",expect_full:true,expected_calls:0,expected_skip:"unsafe_task_context"},
  {...base,id:"safe-command-env-reference",command:'node -e "const value = process.env.TOKEN; const client = process.env.ACCESS_TOKEN;"',expected_decision:true},
  {...base,id:"safe-command-windows-path",command:String.raw`synthetic-worker --path 'C:\users\synthetic\safe.txt'`,expected_decision:true},
  {...base,id:"safe-task-unicode-documentation",task:String.raw`Find the failure and explain that \u005f names an underscore.`,expected_decision:true},
];
for (const field of ["manifest_path","src_path","file_name","out_dir"]) {
  const rows=Array.from({length:80},(_,index)=>JSON.stringify({reason:"compiler-artifact",target:{name:`routine_${index}`}}));
  rows[36]=JSON.stringify({reason:"compiler-artifact",[field]:"render(process.env.TOKEN)"});
  rows.push(JSON.stringify({reason:"build-finished",success:true}));
  cases.push({id:`literal-source-path-${field.replaceAll("_","-")}`,kind:"repetitive_log",task:"Read the compiler artifact path and final build result.",command:"cargo build --message-format=json",
    lines:rows,required_lines:[37,81],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
}
const nestedPathRows=Array.from({length:80},(_,index)=>JSON.stringify({Action:"run",Package:"synthetic",Test:`routine_${index}`}));
nestedPathRows.push(JSON.stringify({Action:"output",Package:"synthetic",Output:JSON.stringify({manifest_path:"render(process.env.TOKEN)"})+"\n"}));
nestedPathRows.push(JSON.stringify({Action:"pass",Package:"synthetic"}));
cases.push({id:"nested-literal-source-path",kind:"repetitive_log",task:"Report the emitted artifact path and final status.",command:"go test -json",
  lines:nestedPathRows,required_lines:[81,82],expect_full:true,expected_calls:0,expected_skip:"sensitive"});
module.exports=cases;
