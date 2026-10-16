#!/usr/bin/env node
"use strict";

// Read-only local audit. Never read .env, emit receipt text, or call a provider.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../vscode-control/core");
const { readFileRecord, parseUniqueJson } = require("../vscode-control/private-records");
const { withPublication } = require("../vscode-control/publication-journal");

const METRICS = ["seen", "skipped", "calls", "responsesReceived", "responsesValidated",
  "requestFailures", "requestCancelled", "errors", "completed", "replaced", "candidates",
  "kept", "savedChars", "linesSeen", "linesRelevanceJudged", "linesOmitted",
  "linesActuallyOmitted", "timed", "elapsedMs"];
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const NAMES = new Set(["Bash", "exec", "functions.exec", "exec_command", "wait", "functions.wait", "sleep",
  "spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "interrupt_agent",
  "request_user_input", "request_user_input_async", "webrun", "web.run",
  "mcp__lab_control__lab_session_execute", "mcp__lab_control__lab_session_wait", "classifying",
  "classification_start", "keep", "replace", "candidate", "skip", "error", "relevance_policy",
  "line_policy", "no_omissions", "observe", "missing_task_context", "unsupported_command",
  "mcp_replacement_disabled", "unsupported_envelope", "insufficient_savings", "small", "large",
  "sensitive", "unsafe_task_context", "exact_content", "unsupported_result", "unsupported_route",
  "choice_kept_full_output", "structure_guard", "no_eligible_lines", "tool_input_budget", "line_budget",
  "relevance_budget", "protected_output", "protected_command", "protected_input", "validated_format", "classified"]);
const safeName = text => NAMES.has(text) ? text : "unrecorded";
const safeVersion = text => typeof text === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(text) ? text : "unrecorded";
const count = (map, name, value = 1) => {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger((map[name] || 0) + value)) {
    throw new Error("Invalid audit count");
  }
  map[name] = (map[name] || 0) + value;
};
const freshSummary = () => ({ scopes: 0, metrics: {}, skip_reasons: {}, skip_details: {}, candidate_reasons: {} });

function addActivity(summary, activity) {
  summary.scopes += 1;
  for (const key of METRICS) {
    const metric = summary.metrics[key] ||= { recorded: 0, known_scopes: 0, partial_scopes: 0, unknown_scopes: 0 };
    if (activity[key] === null || activity[key] === undefined) metric.unknown_scopes += 1;
    else {
      count(metric, "recorded", activity[key]);
      metric.known_scopes += 1;
      if (activity.partialCounters.includes(key)) metric.partial_scopes += 1;
    }
  }
  for (const [field, target] of [["skipCounts", "skip_reasons"], ["skipDetails", "skip_details"],
    ["candidateReasons", "candidate_reasons"]]) {
    for (const [reason, value] of Object.entries(activity[field])) count(summary[target], safeName(reason), value);
  }
}

function emptyEvents() {
  return { records: 0, malformed_records: 0, truncated_files: 0, outcomes: {}, providers: {},
    tools: {}, routing: {}, replacements_by_tool: {}, replacement_source_hashes: new Set(),
    fallback_completed_outcomes: { used: 0, not_used: 0, unknown: 0 },
    fallback_completed_replacements: { used: 0, not_used: 0, unknown: 0 },
    fallback_actual_providers: {}, fallback_configured_providers: {},
    requests: 0, elapsed_ms: 0, replacement_original_chars: 0, replacement_visible_chars: 0,
    proposed_omitted_lines: 0, replacement_omitted_lines: 0, api_input_tokens: 0,
    api_output_tokens: 0, usage_records: 0, first_at: null, last_at: null };
}

function addEvent(summary, event) {
  if (!event || typeof event !== "object" || typeof event.status !== "string" || typeof event.reason !== "string") {
    summary.malformed_records += 1; return false;
  }
  const counters = ["requests", "elapsed_ms", "lines_omitted", "original_chars", "capsule_chars"];
  const invalid = value => !Number.isSafeInteger(value) || value < 0;
  if (counters.some(key => event[key] !== undefined && event[key] !== null && invalid(event[key])) ||
      Object.hasOwn(event, "fallback_used") && typeof event.fallback_used !== "boolean" ||
      event.api_usage && ["input_tokens", "output_tokens"].some(key =>
        event.api_usage[key] !== undefined && invalid(event.api_usage[key]))) {
    summary.malformed_records += 1; return false;
  }
  summary.records += 1;
  count(summary.outcomes, `${safeName(event.status)}:${safeName(event.reason)}`);
  const at = typeof event.at === "string" && Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toISOString() : null;
  if (at) {
    summary.first_at = summary.first_at === null || at < summary.first_at ? at : summary.first_at;
    summary.last_at = summary.last_at === null || at > summary.last_at ? at : summary.last_at;
  }
  if (!["replace", "candidate", "keep"].includes(event.status)) return true;
  const actualProvider = ["openai", "typesafe"].includes(event.provider) ? event.provider : "unrecorded";
  count(summary.providers, actualProvider);
  const fallback = event.fallback_used === true ? "used" : event.fallback_used === false ? "not_used" : "unknown";
  count(summary.fallback_completed_outcomes, fallback);
  if (event.status === "replace") count(summary.fallback_completed_replacements, fallback);
  if (event.fallback_used === true) {
    count(summary.fallback_actual_providers, actualProvider);
    count(summary.fallback_configured_providers,
      ["openai", "typesafe"].includes(event.configured_provider) ? event.configured_provider : "unrecorded");
  }
  count(summary.tools, safeName(event.tool));
  count(summary.routing, safeName(event.routing));
  for (const [field, target] of [["requests", "requests"], ["elapsed_ms", "elapsed_ms"],
    ["lines_omitted", "proposed_omitted_lines"]]) {
    if (event[field] !== undefined && event[field] !== null) count(summary, target, event[field]);
  }
  if (event.api_usage && Number.isSafeInteger(event.api_usage.input_tokens) && Number.isSafeInteger(event.api_usage.output_tokens)) {
    count(summary, "api_input_tokens", event.api_usage.input_tokens);
    count(summary, "api_output_tokens", event.api_usage.output_tokens);
    summary.usage_records += 1;
  }
  if (event.status === "replace") {
    count(summary.replacements_by_tool, safeName(event.tool));
    if (/^[a-f0-9]{64}$/.test(event.source_sha256)) summary.replacement_source_hashes.add(event.source_sha256);
    for (const [field, target] of [["original_chars", "replacement_original_chars"],
      ["capsule_chars", "replacement_visible_chars"], ["lines_omitted", "replacement_omitted_lines"]]) {
      if (event[field] !== undefined && event[field] !== null) count(summary, target, event[field]);
    }
  }
  return true;
}

async function readEvents(directory, summary, publicationReader = withPublication) {
  const stable = await publicationReader(directory, async journal => {
    const events = emptyEvents(), replacements = new Set();
    const result = { events, replacements };
    const filename = path.join(directory, "logs/events.jsonl");
    let details;
    try { details = await fs.lstat(filename); } catch (error) { if (error.code === "ENOENT") return result; throw error; }
    const visible = journal?.state === "prepared" ? Math.min(details.size, journal.event_offset) : details.size;
    const start = Math.max(0, visible - 1_048_576);
    const record = await readFileRecord(filename, 1_048_576, { range: { position: start, length: visible - start } });
    if (!record) return result;
    let text = record.bytes.toString("utf8");
    if (start) { events.truncated_files += 1; text = text.slice(text.indexOf("\n") + 1); }
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const event = parseUniqueJson(line), accepted = addEvent(events, event);
        if (accepted && event.status === "replace" && /^[a-f0-9]{32}$/.test(event.id)) replacements.add(event.id);
      } catch { events.malformed_records += 1; }
    }
    return result;
  });
  // Publication can retry a read. Merge only the accepted, stable attempt.
  for (const [key, value] of Object.entries(stable.events)) {
    if (typeof value === "number") count(summary, key, value);
    else if (value instanceof Set) for (const entry of value) summary[key].add(entry);
    else if (key === "first_at") summary[key] = summary[key] === null || value !== null && value < summary[key] ? value : summary[key];
    else if (key === "last_at") summary[key] = summary[key] === null || value !== null && value > summary[key] ? value : summary[key];
    else for (const [name, amount] of Object.entries(value)) count(summary[key], name, amount);
  }
  return stable.replacements;
}

async function inspectReplacementReceipts(directory, dataRoot, publishedIds, summary) {
  const logs = path.join(directory, "logs");
  const seenIds = new Set();
  let folders;
  try { folders = await fs.readdir(logs, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const folder of folders) {
    if (!/^\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/.test(folder.name)) continue;
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Unsafe receipt folder");
    for (const entry of await fs.readdir(path.join(logs, folder.name), { withFileTypes: true })) {
      const match = /^receipt-([a-f0-9]{32})\.json$/.exec(entry.name);
      if (!match || !publishedIds.has(match[1])) continue;
      if (seenIds.has(match[1])) { summary.duplicate_receipt_files += 1; continue; }
      const record = await readFileRecord(path.join(logs, folder.name, entry.name), 8 * 1024 * 1024);
      if (!record) continue;
      const receipt = parseUniqueJson(record.bytes);
      if (receipt.manifest?.status !== "replace" || receipt.manifest.id !== match[1] ||
          typeof receipt.initial_output !== "string" || typeof receipt.visible_output !== "string") {
        throw new Error("Invalid replacement receipt");
      }
      seenIds.add(match[1]);
      summary.records += 1; count(summary.tools, safeName(receipt.tool));
      count(summary.providers, ["openai", "typesafe"].includes(receipt.manifest.provider) ? receipt.manifest.provider : "unrecorded");
      count(summary, "original_bytes", Buffer.byteLength(receipt.initial_output));
      count(summary, "visible_bytes", Buffer.byteLength(receipt.visible_output));
      if (/synthetic|dummy|fixture/i.test(receipt.initial_output)) summary.explicit_fixture_text_records += 1;
      const original = /(?:^|\n)\[(?:Codex Decision|Jev): \d+ of \d+ lines omitted; full original: ([^\]\n]+)\]/.exec(receipt.visible_output)?.[1];
      if (!original) { summary.missing_original_reference += 1; continue; }
      const relative = path.relative(path.join(dataRoot, "outputs"), original);
      if (path.isAbsolute(relative) || !/^[a-f0-9]{20}[/\\][a-f0-9]{20}\.txt$/.test(relative)) {
        summary.reference_outside_current_originals += 1; continue;
      }
      await core.validateDirectoryPath(path.dirname(original));
      const saved = await readFileRecord(original, 8 * 1024 * 1024);
      if (!saved) summary.missing_saved_original += 1;
      else if (!saved.bytes.equals(Buffer.from(receipt.initial_output))) summary.original_content_mismatch += 1;
      else summary.verified_saved_original += 1;
    }
  }
}

async function inventoryOriginals(directory) {
  const result = { readable_files: 0, typed_files: 0, readable_bytes: 0, typed_bytes: 0 };
  const root = path.join(directory, "outputs");
  try { await core.validateDirectoryPath(root); await fs.access(root); }
  catch (error) { if (error.code === "ENOENT") return result; throw error; }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!/^[a-f0-9]{20}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe originals directory");
    for (const file of await fs.readdir(path.join(root, entry.name), { withFileTypes: true })) {
      const match = /^[a-f0-9]{20}\.(txt|json)$/.exec(file.name);
      if (!match) continue;
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Unsafe saved original");
      const details = await fs.lstat(path.join(root, entry.name, file.name));
      const kind = match[1] === "txt" ? "readable" : "typed";
      count(result, `${kind}_files`); count(result, `${kind}_bytes`, details.size);
    }
  }
  return result;
}

async function* rolloutFiles(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(filename);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield filename;
  }
}

// Read records with a bound before decoding. Rollouts can contain image payloads.
async function* lines(filename, coverage) {
  const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("Unsafe rollout file");
    let pending = [], size = 0, dropping = false;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      let start = 0;
      for (let i = 0; i <= chunk.length; i += 1) {
        if (i !== chunk.length && chunk[i] !== 10) continue;
        const part = chunk.subarray(start, i); start = i + 1;
        if (!dropping && size + part.length <= 20 * 1024 * 1024) { pending.push(part); size += part.length; }
        else if (!dropping) { coverage.oversized_records += 1; pending = []; size = 0; dropping = true; }
        if (i < chunk.length) {
          if (!dropping) yield Buffer.concat(pending, size).toString("utf8");
          pending = []; size = 0; dropping = false;
        }
      }
    }
    if (size || dropping) coverage.incomplete_records += 1;
  } finally { await file.close(); }
}

function omissionMarkers(output) {
  if (typeof output !== "string") return 0;
  // A full rendered header is needed. Quoted source-code literals do not count.
  return [...output.matchAll(/(?:^|\n)\[(?:Codex Decision|Jev): \d+ of \d+ lines omitted; full original: [^\]\n]+\]/g)].length;
}

async function reconcileRollouts(root, sessionHashes) {
  await core.validateDirectoryPath(root);
  const result = { files_considered: 0, matched_session_files: 0, matched_session_scopes: 0,
    unmatched_plugin_scopes: 0, tool_result_items: 0, tool_calls: {}, versions: {},
    omission_headers: 0, tool_results_with_omission_headers: 0, unique_tool_result_items: 0,
    global_unique_tool_result_items: 0, inherited_or_repeated_tool_result_items: 0,
    duplicate_tool_result_items: 0, malformed_records: 0,
    oversized_records: 0, incomplete_records: 0 };
  const matched = new Set();
  const seenResults = new Set(), globalResults = new Set(), seenCalls = new Set();
  for await (const filename of rolloutFiles(root)) {
    result.files_considered += 1;
    // The filename owns the rollout. Forked history can retain parent session_meta.
    const match = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/.exec(filename);
    if (!match || !sessionHashes.has(sha(match[1]))) continue;
    const newScope = !matched.has(sha(match[1]));
    matched.add(sha(match[1])); result.matched_session_files += 1;
    let versionSeen = false;
    for await (const line of lines(filename, result)) {
      let record;
      try { record = JSON.parse(line); } catch { result.malformed_records += 1; continue; }
      const payload = record?.payload;
      if (record.type === "session_meta" && !versionSeen) {
        if (newScope) count(result.versions, safeVersion(payload?.cli_version));
        versionSeen = true;
      }
      if (record.type !== "response_item" || !payload) continue;
      if (["function_call", "custom_tool_call"].includes(payload.type)) {
        const signature = sha(`${match[1]}:${payload.call_id}:${payload.name}`);
        if (!seenCalls.has(signature)) { seenCalls.add(signature); count(result.tool_calls, safeName(payload.name)); }
      }
      if (!["function_call_output", "custom_tool_call_output"].includes(payload.type)) continue;
      result.tool_result_items += 1;
      const signature = sha(`${match[1]}:${payload.call_id}:${JSON.stringify(payload.output)}`);
      if (seenResults.has(signature)) { result.duplicate_tool_result_items += 1; continue; }
      seenResults.add(signature); result.unique_tool_result_items += 1;
      const globalSignature = sha(`${payload.call_id}:${JSON.stringify(payload.output)}`);
      if (globalResults.has(globalSignature)) result.inherited_or_repeated_tool_result_items += 1;
      else { globalResults.add(globalSignature); result.global_unique_tool_result_items += 1; }
      const headers = typeof payload.output === "string" ? omissionMarkers(payload.output) :
        Array.isArray(payload.output) ? payload.output.reduce((sum, item) => sum + omissionMarkers(item?.text), 0) : 0;
      result.omission_headers += headers;
      result.tool_results_with_omission_headers += Number(headers > 0);
    }
  }
  result.matched_session_scopes = matched.size;
  result.unmatched_plugin_scopes = sessionHashes.size - matched.size;
  return result;
}

async function audit({ dataDirectory, rolloutDirectory, observationDate }) {
  if (!path.isAbsolute(dataDirectory) || rolloutDirectory && !path.isAbsolute(rolloutDirectory)) throw new Error("Use absolute audit scopes");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observationDate) || new Date(`${observationDate}T00:00:00Z`).toISOString().slice(0, 10) !== observationDate) {
    throw new Error("Use a valid observation date");
  }
  await core.validateSessionPath(dataDirectory);
  const result = { schema_version: 1, observation_date: observationDate,
    started_at_utc: new Date().toISOString(), root_legacy_scope: freshSummary(),
    session_scopes: freshSummary(), exact_health_scopes: freshSummary(), health_versions: {},
    session_count: 0, session_health_count: 0, empty_session_count: 0,
    first_health_at: null, last_health_at: null, retained_events: emptyEvents(),
    retained_replacement_receipts: { records: 0, duplicate_receipt_files: 0, tools: {}, providers: {}, original_bytes: 0,
      visible_bytes: 0, explicit_fixture_text_records: 0, missing_original_reference: 0,
      reference_outside_current_originals: 0, missing_saved_original: 0, original_content_mismatch: 0,
      verified_saved_original: 0 },
    limits: ["No credential reads or provider requests", "No private text, identifiers, or paths in output",
      "Mixed normal and synthetic activity; replacement is not a delivery acknowledgement",
      "Missing rollout headers do not prove absent model-visible hook feedback; no delivery acknowledgement is available",
      "Lifetime metrics retain coverage; event tails are bounded to 1 MiB per scope",
      "Cross-session reads are an observation interval, not an atomic installation snapshot"] };
  addActivity(result.root_legacy_scope, await core.readSessionActivity(dataDirectory));
  const rootReplacements = await readEvents(dataDirectory, result.retained_events);
  await inspectReplacementReceipts(dataDirectory, dataDirectory, rootReplacements, result.retained_replacement_receipts);
  const sessionRoot = path.join(dataDirectory, "sessions");
  await core.validateDirectoryPath(sessionRoot);
  const hashes = new Set();
  for (const entry of await fs.readdir(sessionRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe audit session");
    hashes.add(entry.name); result.session_count += 1;
    const directory = path.join(sessionRoot, entry.name);
    const activity = await core.readSessionActivity(directory);
    addActivity(result.session_scopes, activity);
    if (activity.hookHealth) {
      result.session_health_count += 1;
      const health = activity.hookHealth;
      count(result.health_versions, safeVersion(health.hook_version));
      if (health.counter_scheme === 1 && health.partial_counters.length === 0) addActivity(result.exact_health_scopes, activity);
      const at = new Date(health.last_seen_ms).toISOString();
      result.first_health_at = result.first_health_at === null || at < result.first_health_at ? at : result.first_health_at;
      result.last_health_at = result.last_health_at === null || at > result.last_health_at ? at : result.last_health_at;
    } else if (activity.calls === 0 && activity.completed === 0) result.empty_session_count += 1;
    const replacements = await readEvents(directory, result.retained_events);
    await inspectReplacementReceipts(directory, dataDirectory, replacements, result.retained_replacement_receipts);
  }
  result.retained_events.distinct_replacement_source_hashes = result.retained_events.replacement_source_hashes.size;
  delete result.retained_events.replacement_source_hashes;
  result.saved_original_inventory = await inventoryOriginals(dataDirectory);
  if (rolloutDirectory) result.rollout_observation = await reconcileRollouts(rolloutDirectory, hashes);
  result.finished_at_utc = new Date().toISOString();
  return result;
}

async function selfTest() {
  const assert = require("node:assert/strict");
  const summary = freshSummary();
  addActivity(summary, { calls: 4, completed: null, partialCounters: ["calls"], skipCounts: { small: 7 }, skipDetails: {}, candidateReasons: {} });
  assert.deepEqual(summary.metrics.calls, { recorded: 4, known_scopes: 1, partial_scopes: 1, unknown_scopes: 0 });
  assert.equal(summary.metrics.completed.unknown_scopes, 1);
  const events = emptyEvents();
  addEvent(events, { status: "candidate", reason: "observe", original_chars: 1000, capsule_chars: 10, lines_omitted: 50,
    provider: "typesafe", tool: "Bash", private_task: "PRIVATE_SENTINEL", tool_input: { secret: "PRIVATE_SENTINEL" } });
  assert.equal(events.proposed_omitted_lines, 50);
  assert.equal(events.replacement_omitted_lines, 0);
  assert.equal(JSON.stringify(events).includes("PRIVATE_SENTINEL"), false);
  assert.equal(omissionMarkers('[Codex Decision: 2 of 4 lines omitted; full original: /private/original.txt]\nkept'), 1);
  assert.equal(omissionMarkers('source code: "[Codex Decision: 2 of 4 lines omitted; full original: /private/original.txt]"'), 0);
  assert.equal(safeName("/private/path"), "unrecorded");
  const temporary = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "decision-usage-audit-"));
  try {
    const file = path.join(temporary, "records.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ content: "PRIVATE_SENTINEL" })}\npartial`);
    const coverage = { oversized_records: 0, incomplete_records: 0 };
    let read = 0; for await (const line of lines(file, coverage)) { assert.equal(JSON.parse(line).content, "PRIVATE_SENTINEL"); read += 1; }
    assert.equal(read, 1); assert.equal(coverage.incomplete_records, 1);
  } finally { await fs.rm(temporary, { recursive: true }); }
  return { checks: 10, passed: true };
}

module.exports = { audit, addActivity, addEvent, emptyEvents, readEvents, omissionMarkers, reconcileRollouts, selfTest };
if (require.main === module) (async () => {
  if (process.argv.includes("--self-test")) { process.stdout.write(`${JSON.stringify(await selfTest())}\n`); return; }
  const args = process.argv.slice(2), options = {};
  const fields = { "--data-dir": "dataDirectory", "--codex-sessions": "rolloutDirectory", "--observation-date": "observationDate" };
  for (let index = 0; index < args.length; index += 2) {
    if (!fields[args[index]] || !args[index + 1]) throw new Error("Use --data-dir PATH [--codex-sessions PATH] --observation-date YYYY-MM-DD");
    options[fields[args[index]]] = args[index + 1];
  }
  if (!options.dataDirectory || !options.observationDate) throw new Error("Data directory and observation date are required");
  process.stdout.write(`${JSON.stringify(await audit(options), null, 2)}\n`);
})().catch(() => { process.stderr.write("Usage audit failed. Check scope, record safety, and arguments locally; no private error details were emitted.\n"); process.exitCode = 1; });
