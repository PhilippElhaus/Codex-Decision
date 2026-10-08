"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {readFileRecord,parseUniqueJson,parseUnsignedJson,validateStatsRecord,validateDirectoryPath,validateSessionPath} = require("./private-records");
const JOURNAL_NAME = ".decision-publication.json";
const JOURNAL_LIMIT = 128 * 1024;
const EVENT_LIMIT = 32 * 1024;
const SNAPSHOT_LIMIT = 8 * 1024 * 1024;
const FIELDS = ["version","state","receipt_id","folder","event_offset","commit_event","commit_sha256",
  "prior_stats","next_stats","prior_snapshot","next_snapshot","artifacts"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const object = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value,field));
const image = (value, limit) => object(value,["bytes","sha256"]) && Number.isSafeInteger(value.bytes) &&
  value.bytes >= 0 && value.bytes <= limit && /^[a-f0-9]{64}$/.test(value.sha256);
const matches = (description, record) => description && record && description.bytes === record.bytes.length &&
  description.sha256 === digest(record.bytes);

function validateJournal(bytes) {
  if (bytes.length > JOURNAL_LIMIT) throw new Error("Decision publication journal is too large");
  const value = parseUnsignedJson(bytes,keys => keys.length === 1 && ["version","event_offset"].includes(keys[0]) ||
    keys.at(-1) === "bytes" && ["prior_snapshot","next_snapshot","next_stats","artifacts"].includes(keys[0]));
  if (!object(value,FIELDS) || value.version !== 1 || !["prepared","committed"].includes(value.state) ||
      !/^[a-f0-9]{32}$/.test(value.receipt_id) || !/^\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/.test(value.folder) ||
      !Number.isSafeInteger(value.event_offset) || value.event_offset < 0 || typeof value.commit_event !== "string" ||
      Buffer.byteLength(value.commit_event) > EVENT_LIMIT || !value.commit_event.endsWith("\n") ||
      !Number.isSafeInteger(value.event_offset + Buffer.byteLength(value.commit_event)) ||
      value.commit_sha256 !== digest(Buffer.from(value.commit_event)) || !image(value.next_stats,8192) ||
      value.prior_snapshot !== null && !image(value.prior_snapshot,SNAPSHOT_LIMIT) ||
      value.next_snapshot !== null && !image(value.next_snapshot,SNAPSHOT_LIMIT) ||
      value.next_snapshot === null && value.prior_snapshot !== null || !Array.isArray(value.artifacts)) {
    throw new Error("Invalid Decision publication journal");
  }
  const day = value.folder.slice(0,10), timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10) !== day) throw new Error("Invalid Decision publication date");
  parseUniqueJson(value.commit_event);
  if (value.prior_stats !== null) {
    if (typeof value.prior_stats !== "string" || Buffer.byteLength(value.prior_stats) > 8192) throw new Error("Invalid Decision publication stats");
    validateStatsRecord(parseUnsignedJson(value.prior_stats,keys => keys.length === 1));
  }
  const names = new Set();
  for (const artifact of value.artifacts) {
    if (!object(artifact,["name","bytes","sha256"]) || typeof artifact.name !== "string") throw new Error("Invalid Decision publication artifact");
    const receipt = artifact.name === `receipt-${value.receipt_id}.json`;
    const batch = new RegExp(`^batch-${value.receipt_id}-(0|[1-9][0-9]*)\\.json$`).exec(artifact.name);
    if (!receipt && (!batch || Number(batch[1]) > 10_000) || names.has(artifact.name) ||
        !image({bytes:artifact.bytes,sha256:artifact.sha256},receipt ? SNAPSHOT_LIMIT : 2 * 1024 * 1024)) {
      throw new Error("Invalid Decision publication artifact");
    }
    names.add(artifact.name);
  }
  return value;
}

async function readJournal(directory) {
  const record = await readFileRecord(path.join(directory,"logs",JOURNAL_NAME),JOURNAL_LIMIT,{strict:true});
  return record ? {record,value:validateJournal(record.bytes),hash:digest(record.bytes)} : null;
}

async function withPublication(directory, action) {
  await validateSessionPath(directory);
  await validateDirectoryPath(path.join(directory,"logs"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readJournal(directory);
    let result, failure;
    try {
      if (before) {
        const expected = Buffer.from(before.value.commit_event);
        const extra = Number.isSafeInteger(before.value.event_offset + expected.length + 1) ? 1 : 0;
        const event = await readFileRecord(path.join(directory,"logs","events.jsonl"),EVENT_LIMIT+1,
          {strict:true,range:{position:before.value.event_offset,length:expected.length+extra}});
        const tail = event ? event.size-before.value.event_offset : -1;
        if (!event || tail < 0 || tail > expected.length || event.bytes.length > expected.length ||
            !event.bytes.equals(expected.subarray(0,event.bytes.length)) ||
            before.value.state === "committed" && (tail !== expected.length || !event.bytes.equals(expected))) {
          throw new Error("Decision publication event changed");
        }
      }
      result = await action(before?.value || null);
    } catch (error) {failure = error;}
    const after = await readJournal(directory);
    if (before?.hash === after?.hash && before?.record.fingerprint === after?.record.fingerprint) {
      if (failure) throw failure;
      return result;
    }
  }
  throw new Error("Decision publication changed while being read");
}

async function readPublishedRecord(directory, kind, readCurrent) {
  if (!["stats","snapshot"].includes(kind)) throw new Error("Invalid Decision publication image");
  return withPublication(directory,async journal => {
    const current = await readCurrent({strict:journal !== null && (kind === "stats" || journal.next_snapshot !== null)});
    if (!journal || kind === "snapshot" && journal.next_snapshot === null) return current;
    const before = kind === "stats" ? journal.prior_stats === null ? null :
      {bytes:Buffer.from(journal.prior_stats),fingerprint:`prior-stats:${digest(Buffer.from(journal.prior_stats))}`} : journal.prior_snapshot;
    const after = kind === "stats" ? journal.next_stats : journal.next_snapshot;
    const priorMatches = kind === "stats" ? before === null ? current === null :
      current && before.bytes.equals(current.bytes) : before === null ? current === null : matches(before,current);
    if (journal.state === "committed") {
      if (!matches(after,current)) throw new Error("Committed Decision publication image changed");
      return current;
    }
    if (!priorMatches && !matches(after,current)) throw new Error("Pending Decision publication image changed");
    if (kind === "stats") return before;
    if (priorMatches) return current;
    if (before === null) return null;
    const backup = await readFileRecord(path.join(directory,"logs",`.decision-publication-${journal.receipt_id}.snapshot-before`),
      SNAPSHOT_LIMIT,{strict:true});
    if (!matches(before,backup)) throw new Error("Decision publication snapshot backup changed");
    return backup;
  });
}

module.exports = {validateJournal,withPublication,readPublishedRecord,JOURNAL_NAME,JOURNAL_LIMIT};
