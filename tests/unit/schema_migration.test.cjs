"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { defaults, validate } = require("../../vscode-control/schema");
const core = require("../../vscode-control/core");

test("flat legacy policies migrate conservatively and cannot disable classification", () => {
  const old = {...defaults("config_v3"),enabled:true,choice_gate_enabled:false,
    line_policy:{omit_min:70,exact_max:25}};
  const migrated=validate("config",old);
  assert.equal(migrated.schema_version,5);
  assert.deepEqual(migrated.relevance_policy,{relevant_max:5});
  assert.equal("choice_gate_enabled" in migrated,false);
  assert.equal("line_policy" in migrated,false);
  assert.throws(()=>validate("config",{...old,line_policy:{omit_min:"70",exact_max:25}}));
});

test("legacy selections migrate to one switch with conservative shared cutoffs", () => {
  for (const enabled of [false, true]) for (const test_build_enabled of [false, true])
    for (const search_listing_enabled of [false, true]) {
      const raw = { ...defaults("config_v2"), enabled, test_build_enabled, search_listing_enabled,
        line_policy: { output: { omit_min: 80, exact_max: 20 },
          test_build: { omit_min: 98, exact_max: 4 }, search_listing: { omit_min: 92, exact_max: 2 } } };
      const migrated = validate("config", raw);
      assert.equal(migrated.schema_version, 5);
      assert.equal(migrated.enabled, enabled || test_build_enabled || search_listing_enabled);
      assert.deepEqual(migrated.relevance_policy, { relevant_max: 2 });
      assert.equal("test_build_enabled" in migrated, false);
      assert.equal("search_listing_enabled" in migrated, false);
      assert.equal("search_relevance" in migrated, false);
      assert.equal(raw.schema_version, 2, "reading must not modify its input");
    }
  assert.throws(() => validate("config", { ...defaults("config_v2"), test_build_enabled: "yes" }));
  assert.throws(() => validate("config", { ...defaults("config_v2"), unknown: true }));
  assert.throws(() => validate("config", { ...defaults("config"), search_listing_enabled: true }));
});

test("saving a legacy session or shared settings writes only the current contract", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-migration-"));
  try {
    const raw = { ...defaults("config_v2"), enabled: false, test_build_enabled: true, min_chars: 4096 };
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify(raw));
    assert.equal((await core.readConfig(root)).enabled, true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "config.json"))), raw);
    await core.writeSelection(root, false);
    const stored = JSON.parse(await fs.readFile(path.join(root, "config.json")));
    assert.equal(stored.schema_version, 5);
    assert.equal(stored.enabled, false);
    assert.equal(stored.min_chars, 4096);
    assert.equal("test_build_enabled" in stored, false);
    const oldSettings = { ...defaults("settings_v1"), mode: "observe", never_delete_logs: true,
      log_limit_mb: 123, line_policy: { output: { omit_min: 91, exact_max: 6 },
        test_build: { omit_min: 97, exact_max: 3 }, search_listing: { omit_min: 94, exact_max: 4 } } };
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(oldSettings));
    assert.deepEqual((await core.readGlobalSettings(root)).relevance_policy, { relevant_max: 3 });
    await core.writeGlobalSettings(root, { mode: "replace" });
    const settings = JSON.parse(await fs.readFile(path.join(root, "settings.json")));
    assert.equal(settings.schema_version, 4);
    assert.equal(settings.log_limit_mb, 123);
    assert.equal(settings.never_delete_logs, true);
    assert.equal("search_relevance" in settings, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
