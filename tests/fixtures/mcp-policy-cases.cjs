"use strict";
const lines=[...Array.from({length:80},(_,index)=>`INFO synthetic background poll ${index}`),"ERROR synthetic failure","Done"];
const base={kind:"repetitive_log",task:"Identify the synthetic failure and final completion.",command:"",tool_input:{},lines,required_lines:[81,82],expected_classification_calls:0};
module.exports=[
  {...base,id:"generic-mcp-disabled",tool:"mcp__synthetic__read_log",expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"},
  {...base,id:"generic-mcp-alias-disabled",tool:"functions.mcp__synthetic__read_log",expect_full:true,expected_calls:0,expected_skip:"mcp_replacement_disabled"},
  {...base,id:"generic-mcp-monitor",tool:"mcp__synthetic__read_log",mode:"observe",expect_full:true,expected_decision:true},
  {...base,id:"generic-mcp-enabled",tool:"mcp__synthetic__read_log",allow_mcp_replacement:true,expected_decision:true},
];
