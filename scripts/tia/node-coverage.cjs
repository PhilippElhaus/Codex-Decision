"use strict";
// --require also loads in Node's test coordinator, which has no inspector.
if (process.env.NODE_TEST_CONTEXT && !process.env.DECISION_TIA_WORKER_PID) {
process.env.DECISION_TIA_WORKER_PID = String(process.pid);
// Precise V8 function coverage is sampled around each top-level node:test case.
// Nested cases are folded into their parent so native name filtering is safe.
const fs = require("node:fs");
const path = require("node:path");
const inspector = require("node:inspector");
const { fileURLToPath } = require("node:url");
const { beforeEach, afterEach } = require("node:test");
const root = path.resolve(__dirname, "../..");
const session = new inspector.Session();
session.connect();
function post(method, params = {}) {
  let value, failure;
  session.post(method, params, (error, result) => { failure = error; value = result; });
  if (failure) throw failure;
  if (!value) throw new Error(`Asynchronous inspector operation: ${method}`);
  return value;
}
post("Profiler.enable");
post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
const functions = {}, startup = {}, tests = [];
let current = null, depth = 0;
const sources = new Map();
const originalRead = fs.readFileSync.bind(fs), startupReads = new Set();
function trackRead(filename) {
  if (filename instanceof URL) filename = fileURLToPath(filename);
  if (Buffer.isBuffer(filename)) filename = filename.toString("utf8");
  if (typeof filename !== "string") return;
  const relative = path.relative(root, path.resolve(filename)).split(path.sep).join("/");
  if (relative.startsWith("../") || relative.startsWith("scripts/tia/") || !/\.(?:js|cjs|py|rs)$/.test(relative)) return;
  // CommonJS's own module load is covered by V8. Explicit source reads and
  // VM loads are additional dependencies, including module-initialization reads.
  const caller = new Error().stack.split("\n")[3] || "";
  if (caller.includes("node:internal/modules/")) return;
  (current?.readset || startupReads).add(relative);
}
for (const [object, methods] of [[fs, ["readFileSync", "readFile", "openSync", "open"]],
  [require("node:fs/promises"), ["readFile", "open"]]]) {
  for (const method of methods) {
    const original = object[method];
    object[method] = function (...args) { trackRead(args[0]); return Reflect.apply(original, this, args); };
  }
}
const processes = require("node:child_process"), promisify = require("node:util").promisify.custom;
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = processes[method];
  const mark = () => (current?.readset || startupReads).add("*process*");
  const wrapped = function (...args) { mark(); return Reflect.apply(original, this, args); };
  const descriptors = Object.getOwnPropertyDescriptors(original);
  if (descriptors[promisify]?.value) {
    const custom = descriptors[promisify].value;
    descriptors[promisify].value = function (...args) { mark(); return Reflect.apply(custom, this, args); };
  }
  Object.defineProperties(wrapped, descriptors);
  processes[method] = wrapped;
}
function merge(target, other) {
  for (const [name, spans] of Object.entries(other)) {
    const set = new Map((target[name] || []).map(s => [s.join(":"), s]));
    for (const span of spans) set.set(span.join(":"), span);
    target[name] = [...set.values()];
  }
}
function take() {
  const covered = {};
  for (const script of post("Profiler.takePreciseCoverage").result) {
    if (!script.url.startsWith("file:")) continue;
    const absolute = fileURLToPath(script.url), relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative.startsWith("../") || relative.startsWith("scripts/tia/") || !/\.(?:js|cjs)$/.test(relative)) continue;
    if (!sources.has(absolute)) sources.set(absolute, originalRead(absolute, "utf8"));
    const source = sources.get(absolute);
    for (const fn of script.functions) {
      const range = fn.ranges[0];
      // V8's script-level range is not a callable function dependency.
      if (range.startOffset === 0 && range.endOffset >= source.length - 1) continue;
      const span = [source.slice(0, range.startOffset).split("\n").length,
        source.slice(0, range.endOffset).split("\n").length];
      merge(functions, { [relative]: [span] });
      if (range.count > 0) merge(covered, { [relative]: [span] });
    }
  }
  return covered;
}
beforeEach(context => {
  if (depth && context.fullName === context.name) throw new Error("Concurrent top-level cases need full-suite execution");
  if (depth++ === 0) {
    merge(startup, take());
    current = { id: context.name, name: context.name, file: process.env.DECISION_TIA_ENTRY, spans: {}, readset: new Set() };
  }
});
afterEach(() => {
  merge(current.spans, take());
  if (--depth === 0) { tests.push(current); current = null; }
});
process.once("exit", () => {
  // File hooks and initialization may affect every case in this worker.
  merge(startup, take());
  for (const test of tests) {
    merge(test.spans, startup); test.id = `${test.file}::${test.name}`;
    test.reads = [...new Set([...test.readset, ...startupReads])];
    delete test.readset;
  }
  const destination = process.env.DECISION_TIA_RECORD;
  if (!destination) throw new Error("Coverage destination is required");
  fs.writeFileSync(destination, JSON.stringify({ tests, functions }));
  post("Profiler.stopPreciseCoverage");
  session.disconnect();
});
}
