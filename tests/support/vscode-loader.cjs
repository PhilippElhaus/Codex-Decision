"use strict";
const Module = require("node:module");

// Call with require.resolve(...) at the test site. Restore the loader even if
// module initialization throws. Tests using process-wide mocks stay sequential.
function loadWithVscode(filename, vscode) {
  const original = Module._load;
  try {
    Module._load = function (request, parent, isMain) {
      return request === "vscode" ? vscode : original.call(this, request, parent, isMain);
    };
    delete require.cache[filename];
    return require(filename);
  } finally { Module._load = original; }
}

async function until(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for bridge state");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

module.exports = { loadWithVscode, until };
