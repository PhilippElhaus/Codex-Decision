"use strict";
// Hash each invocation's sequential wire bytes, then fold in fixture order.
// Concurrent arrival order must not change a semantic before/after fingerprint.
const crypto = require("node:crypto");

class InvocationFingerprint {
  constructor() {
    this.hash = crypto.createHash("sha256");
    this.length = Buffer.allocUnsafe(4);
  }
  add(bytes) {
    this.length.writeUInt32BE(bytes.length);
    this.hash.update(this.length).update(bytes);
  }
  finish() { return this.hash.digest(); }
}

function foldInvocations(hash, runs) {
  const length = Buffer.allocUnsafe(4);
  for (const run of runs) {
    const name = Buffer.from(run.id);
    length.writeUInt32BE(name.length);
    hash.update(length).update(name).update(run.wireFingerprint.finish());
  }
}

module.exports = { InvocationFingerprint, foldInvocations };
