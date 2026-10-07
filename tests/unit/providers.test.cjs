"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { provider, wireRequest, parseHealthResult } = require("../../vscode-control/providers");
const { readApiKey, writeApiKey, checkHealth, readGlobalSettings, writeGlobalSettings } = require("../../vscode-control/core");
const { validate } = require("../../vscode-control/schema");

test("default provider uses Decisions predicate API and validates refusals", () => {
  assert.equal(provider().endpoint, "https://api.openai.com/v1/decisions");
  const request = wireRequest({model:"gpt-6-luna",state:{text:"λ"},questions:{ready:{type:"noul",instructions:"Is it ready?"}}});
  assert.equal(JSON.parse(request.input).text,"λ");
  assert.deepEqual(request.questions,[{name:"ready",type:"predicate",instructions:"Is it ready?"}]);
  assert.deepEqual(parseHealthResult({model:"gpt-6-luna",answers:[{name:"ready",type:"predicate",probability:0.9}]}),{ok:true,model:"gpt-6-luna"});
  for (const answer of [{name:"ready",type:"refusal"},{name:"other",type:"predicate",probability:.9},{name:"ready",type:"predicate",probability:1.1}])
    assert.throws(()=>parseHealthResult({model:"gpt-6-luna",answers:[answer]}));
});

test("provider keys coexist and health requests use only the selected credential", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-providers-"));
  try {
    await writeApiKey(directory,"synthetic-openai-key");
    await writeApiKey(directory,"synthetic-typesafe-key","typesafe");
    await writeApiKey(directory,"updated-openai-key");
    assert.equal(await readApiKey(directory),"updated-openai-key");
    assert.equal(await readApiKey(directory,"typesafe"),"synthetic-typesafe-key");
    await writeGlobalSettings(directory,{provider:"typesafe",model:"jev-latest"});
    const result = await checkHealth(directory, async (url,options)=>{
      assert.equal(url,provider("typesafe").endpoint);
      assert.equal(options.headers.Authorization,"Bearer synthetic-typesafe-key");
      assert.equal(JSON.parse(options.body).questions.ready.type,"noul");
      return {ok:true,text:async()=>JSON.stringify({model:"jev-latest",answers:{ready:{type:"noul",noul:.9}}})};
    });
    assert.equal(result.ok,true);
    const old = validate("settings",{schema_version:3,mode:"replace",relevance_policy:{relevant_max:5},log_limit_mb:50,never_delete_logs:false});
    assert.equal(old.provider,"typesafe");
    assert.throws(()=>validate("settings",{...old,provider:"openai"}));
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});

test("shared behavior changes preserve the legacy provider when settings are absent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),"decision-legacy-settings-"));
  const legacy = {provider:"typesafe", model:"jev-latest"};
  try {
    assert.equal((await readGlobalSettings(directory)).provider,"openai");
    assert.equal((await readGlobalSettings(directory,legacy)).provider,"typesafe");
    await writeGlobalSettings(directory,{never_delete_logs:true},legacy);
    assert.equal((await readGlobalSettings(directory)).provider,"typesafe");
    await writeGlobalSettings(directory,{provider:"openai",model:"gpt-6-luna"},legacy);
    assert.equal((await readGlobalSettings(directory,legacy)).provider,"openai");
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
