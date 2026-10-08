"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { InvocationFingerprint, foldInvocations } = require("../../scripts/pipeline-stress/fingerprints.cjs");

function fingerprint(arrivals) {
  const runs = ["first", "second"].map(id => ({ id, wireFingerprint: new InvocationFingerprint() }));
  for (const [worker, text] of arrivals) runs[worker].wireFingerprint.add(Buffer.from(text));
  const hash = crypto.createHash("sha256");
  foldInvocations(hash, runs);
  return hash.digest("hex");
}

test("pressure fingerprints ignore cross-invocation scheduling and preserve wire bytes", () => {
  const normal = fingerprint([[0, "first request"], [1, "other request"], [0, "second request"]]);
  assert.equal(normal, fingerprint([[1, "other request"], [0, "first request"], [0, "second request"]]));
  assert.notEqual(normal, fingerprint([[0, "second request"], [1, "other request"], [0, "first request"]]));
  assert.notEqual(normal, fingerprint([[0, "first request!"], [1, "other request"], [0, "second request"]]));
  assert.notEqual(fingerprint([[0, "ab"], [0, "c"]]), fingerprint([[0, "a"], [0, "bc"]]));
});
