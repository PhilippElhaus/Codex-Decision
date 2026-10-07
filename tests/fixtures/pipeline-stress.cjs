"use strict";
const kinds = ["repetitive_log","progress_output","independent_matches","independent_records","exact_content","prose","structured_payload","mixed_or_unknown"];

function fixture(group, worker, count) {
  const id = `run-${group}-${worker}`;
  const envelope=worker%2===1;
  const sourceCount=envelope?Math.min(count,9999):count;
  const lines = Array.from({length:sourceCount-2},(_,i)=>`INFO routine worker poll ${id} item ${i} completed normally`);
  lines.push("ERROR: synthetic endpoint example.invalid port 8443 refused the connection.","Run ended with return value 73.");
  const source=lines.join("\r\n")+"\r\n";
  return {id,source,envelope,projectedLines:sourceCount+Number(envelope),fault:worker%4===3,command:`printf synthetic-output ${id}`,
    response:envelope?{output:source,exit_code:1}:source};
}

function response(wire, provider) {
  const questions=Array.isArray(wire.questions)?wire.questions:Object.entries(wire.questions).map(([name,q])=>({name,...q}));
  const answers=questions.map(q=>q.type==="choice"?{name:q.name,type:"choice",choice:"repetitive_log",confidence:.98,
    probabilities:kinds.map(value=>({value,probability:value==="repetitive_log"?.98:.02/7}))}:
    {name:q.name,type:"predicate",probability:.01});
  if(provider==="openai") return {model:"gpt-6-luna",answers,usage:{input_tokens:100,output_tokens:0}};
  return {model:"jev-1.13.0",answers:Object.fromEntries(answers.map(({name,...a})=>[name,a.type==="predicate"?{type:"noul",noul:a.probability}:
    {...a,probabilities:Object.fromEntries(a.probabilities.map(p=>[p.value,p.probability]))}])),usage:{input_tokens:100,output_tokens:30}};
}

const faultMessages={http:"Decision request failed",json:"invalid decision response",oversize:"Decision response too large",
  probability:"Decision probability out of range",model:"response provider mismatch",timeout:"Decision request failed"};

function faultyResponse(wire,provider,mode) {
  if(mode==="json")return "{invalid synthetic JSON";
  if(mode==="oversize")return "x".repeat(1000001);
  const result=response(wire,provider);
  if(mode==="model")result.model=provider==="openai"?"jev-1.13.0":"gpt-6-luna";
  if(mode==="probability") {
    const answer=Array.isArray(result.answers)?result.answers[0]:Object.values(result.answers)[0];
    if(answer.type==="predicate")answer.probability=1.5;
    else if(answer.type==="noul")answer.noul=1.5;
    else if(Array.isArray(answer.probabilities))answer.probabilities[0].probability=1.5;
    else answer.probabilities.repetitive_log=1.5;
  }
  return JSON.stringify(result);
}

module.exports={fixture,response,faultyResponse,faultMessages};
