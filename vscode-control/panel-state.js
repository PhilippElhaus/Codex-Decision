"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

const CHOICES = { filter_decision: ["filter", "keep"] };
for (let index = 0; index < 12; index += 1) CHOICES[`group_${index}`] = ["retain", "summarize", "drop"];
const CHECKS = new Set(["routine_noise", "needs_exact_text", "one_off_value"]);
const FILTERS = new Set(["output", "test_build", "search_listing"]);
const STATUSES = new Set(["keep", "replace", "candidate", "skip"]);
const THEMES = new Set(["output_filter", "output_keep", "output_noul", "output_evaluated",
  "build_filter", "build_keep", "build_noul", "build_evaluated",
  "search_retain", "search_summarize", "search_drop", "search_mixed", "search_evaluated"]);

function probability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid Jev panel probability");
  }
  return value;
}

function parseRecent(value, latestId) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 ||
      value.at(-1)?.id !== latestId) throw new Error("Invalid Jev panel history");
  const ids = new Set();
  return value.map((row) => {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id) || !THEMES.has(row.theme) ||
        !Number.isInteger(row.elapsed_ms) || row.elapsed_ms < 0 || row.elapsed_ms > 3_600_000 ||
        ids.has(row.id)) throw new Error("Invalid Jev panel history");
    ids.add(row.id);
    return { id: row.id, theme: row.theme, elapsed_ms: row.elapsed_ms };
  });
}

function parsePanelDecision(value) {
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.id) ||
      typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !FILTERS.has(value.filter) || !STATUSES.has(value.status) ||
      !Number.isInteger(value.call_index) || !Number.isInteger(value.call_count) ||
      value.call_index < 1 || value.call_count < value.call_index || value.call_count > 1000 ||
      !Array.isArray(value.choices) || value.choices.length > 12 ||
      !Array.isArray(value.checks) || value.checks.length > 3 ||
      (value.demo !== undefined && typeof value.demo !== "boolean")) {
    throw new Error("Invalid Jev panel decision");
  }
  const choices = value.choices.map((row) => {
    const options = CHOICES[row?.name];
    if (!options || !options.includes(row.selected) || !row.probabilities ||
        Object.keys(row.probabilities).length !== options.length ||
        options.some((option) => !Object.hasOwn(row.probabilities, option))) {
      throw new Error("Invalid Jev panel choice");
    }
    const probabilities = Object.fromEntries(options.map((option) => [option, probability(row.probabilities[option])]));
    const sum = Object.values(probabilities).reduce((total, number) => total + number, 0);
    if (sum < 0.97 || sum > 1.03) throw new Error("Invalid Jev panel choice");
    return { name: row.name, selected: row.selected, probabilities };
  });
  const checks = value.checks.map((row) => {
    if (!CHECKS.has(row?.name)) throw new Error("Invalid Jev panel check");
    return { name: row.name, probability: probability(row.probability) };
  });
  return { id: value.id, at: value.at, filter: value.filter, status: value.status,
    call_index: value.call_index, call_count: value.call_count, choices, checks,
    recent: parseRecent(value.recent, value.id), demo: value.demo === true };
}

async function readLatestPanelDecision(directory) {
  const filename = path.join(directory, "logs", "latest-decision.json");
  let file;
  try {
    const details = await fs.lstat(filename);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 16_384) {
      throw new Error("Unsafe Jev panel decision file");
    }
    file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > 16_384) throw new Error("Unsafe Jev panel decision file");
    return parsePanelDecision(JSON.parse(await file.readFile("utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}

module.exports = { parsePanelDecision, readLatestPanelDecision };
