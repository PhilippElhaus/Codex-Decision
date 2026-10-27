"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { withPublication } = require("./publication-journal");

// Check every source even on a hit. Ledger updates can arrive without events.
async function dependencyFingerprint(directory) {
  // Sample the directory before its children. A journal can appear and vanish
  // while its staged ledger files retain the same identities and contents.
  let logs;
  try {
    const details = await fs.lstat(path.join(directory, "logs"));
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("Unsafe Decision activity directory");
    logs = [details.dev, details.ino, details.birthtimeMs, details.mtimeMs, details.ctimeMs,
      details.mode, details.uid, details.nlink];
  } catch (error) { if (error.code !== "ENOENT") throw error; logs = null; }
  const sources = [["stats.json", 8192], ["logs/hook-health.json", 4096],
    ["logs/events.jsonl", Number.MAX_SAFE_INTEGER]];
  const identities = await Promise.all(sources.map(async ([name, limit]) => {
    let details;
    try { details = await fs.lstat(path.join(directory, name)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!details.isFile() || details.isSymbolicLink() || !Number.isSafeInteger(details.size) ||
        details.size < 0 || details.size > limit) throw new Error("Unsafe Decision activity record");
    return [details.dev, details.ino, details.birthtimeMs, details.mtimeMs, details.ctimeMs,
      details.size, details.mode, details.uid, details.nlink];
  }));
  return JSON.stringify([logs, ...identities]);
}

function createActivityReader(read, limit = 128) {
  if (typeof read !== "function" || !Number.isInteger(limit) || limit < 1 || limit > 1024)
    throw new TypeError("Invalid Decision activity cache");
  const entries = new Map();
  return async function readActivity(directory) {
    const touched = new Set();
    try {
      // Keep publication and directory checks on every caller, including hits.
      const result = await withPublication(directory, async journal => {
        if (journal) {
          entries.delete(directory);
          return { value: await read(directory) };
        }
        const fingerprint = await dependencyFingerprint(directory);
        let entry = entries.get(directory);
        if (!entry || entry.fingerprint !== fingerprint) {
          entry = { fingerprint, result: null, pending: null };
          entry.pending = Promise.resolve().then(async () => {
            const value = await read(directory);
            return { value, stable: fingerprint === await dependencyFingerprint(directory) };
          });
          entries.set(directory, entry);
          while (entries.size > limit) entries.delete(entries.keys().next().value);
        } else {
          entries.delete(directory);
          entries.set(directory, entry);
        }
        touched.add(entry);
        const snapshot = entry.result || await entry.pending;
        return { ...snapshot, entry };
      });
      // A pending read becomes reusable only after the outer journal check.
      if (result.entry && entries.get(directory) === result.entry) {
        if (result.stable) result.entry.result = { value: result.value, stable: true };
        else entries.delete(directory);
      }
      // Installation aggregation and UI controllers may mutate nested maps.
      return structuredClone(result.value);
    } catch (error) {
      if (touched.has(entries.get(directory))) entries.delete(directory);
      throw error;
    }
  };
}

module.exports = { createActivityReader };
