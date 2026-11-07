"use strict";

// Keep paths used by active threads when Codex refreshes its version cache.
const fs = require("node:fs/promises");
const path = require("node:path");
const LIMITS = { versions: 32, entries: 4096, file: 32 * 1024 * 1024, total: 512 * 1024 * 1024 };

module.exports = function cachePreservation({ safePath, writeExact, version, refusal, files: payloadFiles }) {
  const incoming = new Set(payloadFiles);
  const payloadDirectories = new Set([""]);
  for (const filename of payloadFiles) {
    const parts = filename.split("/");
    for (let index = 1; index < parts.length; index++) payloadDirectories.add(parts.slice(0, index).join("/"));
  }
  const sensitive = name => /^(?:\.env(?:\..*)?|auth\.json|credentials?.*|token.*|id_rsa|id_ed25519)$/i.test(name) || /\.(?:key|p12|pfx)$/i.test(name);
  const invalid = () => refusal("Decision cache contains unsafe or unknown installation state; preserve it before repair");
  async function metadata(root, budget) {
    root = await safePath(root);
    const directories = new Map(), files = new Map();
    let rootInfo;
    try { rootInfo = await fs.lstat(root); }
    catch (error) { if (error.code === "ENOENT") return { directories, files }; throw error; }
    if (!rootInfo.isDirectory()) throw invalid();
    directories.set("", rootInfo.mode & 0o777);
    async function visit(directory, relative, depth) {
      if (depth > 32) throw invalid();
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++budget.entries > LIMITS.entries || sensitive(entry.name)) throw invalid();
        const filename = await safePath(path.join(directory, entry.name));
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const stat = await fs.lstat(filename);
        if (stat.isDirectory()) {
          directories.set(name, stat.mode & 0o777);
          await visit(filename, name, depth + 1);
        } else if (stat.isFile()) {
          budget.bytes += stat.size;
          if (stat.size > LIMITS.file || budget.bytes > LIMITS.total) throw invalid();
          files.set(name, { filename, size: stat.size, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino });
        } else throw invalid();
      }
    }
    await visit(root, "", 0);
    return { directories, files };
  }
  async function bytes(record) {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const file = await fs.open(await safePath(record.filename), flags);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== record.size || stat.size > LIMITS.file ||
          record.ino != null && (stat.ino !== record.ino || stat.dev !== record.dev)) throw invalid();
      const buffer = Buffer.alloc(record.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await file.read(buffer, count, buffer.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count !== record.size || (await file.stat()).size !== record.size) throw invalid();
      return buffer.subarray(0, count);
    } finally { await file.close(); }
  }
  async function readFile(filename, limit = LIMITS.file) {
    filename = await safePath(filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > limit) throw refusal("Decision package file is invalid or exceeds its size limit");
    return bytes({ filename, size: stat.size, dev: stat.dev, ino: stat.ino });
  }
  async function snapshot(cacheRoot) {
    cacheRoot = await safePath(cacheRoot);
    let entries;
    try { entries = await fs.readdir(cacheRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
    if (entries.length > LIMITS.versions) throw invalid();
    const snapshots = new Map(), budget = { entries: 0, bytes: 0 };
    // Validate the whole tree before reading any payload file.
    for (const entry of entries) {
      version(entry.name);
      snapshots.set(entry.name, await metadata(path.join(cacheRoot, entry.name), budget));
    }
    for (const [name, saved] of snapshots) {
      const record = saved.files.get(".codex-plugin/plugin.json");
      if (!record || record.size > 128_000) throw invalid();
      let manifest;
      try { manifest = JSON.parse((await bytes(record)).toString("utf8")); }
      catch { throw invalid(); }
      if (manifest.name !== "codex-decision" || manifest.version !== name) throw invalid();
    }
    for (const saved of snapshots.values()) {
      for (const record of saved.files.values()) record.bytes = await bytes(record);
    }
    return snapshots;
  }
  async function backup(snapshots, backupRoot, cacheRoot) {
    if (!snapshots.size) return null;
    await safePath(backupRoot);
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const destination = await fs.mkdtemp(path.join(backupRoot, `${Date.now()}-`));
    const modes = {};
    for (const [name, saved] of snapshots) {
      modes[name] = { directories: Object.fromEntries(saved.directories), files: {} };
      for (const [relative, record] of saved.files) {
        await writeExact(path.join(destination, "cache", name, relative), record.bytes);
        modes[name].files[relative] = record.mode;
      }
    }
    await writeExact(path.join(destination, "cache-rollback.json"), Buffer.from(JSON.stringify({ cacheRoot, modes })));
    return destination;
  }
  async function restore(cacheRoot, snapshots, targetVersion) {
    for (const [name, saved] of snapshots) {
      const target = name === targetVersion;
      const retainedFiles = target ? new Map([...saved.files].filter(([relative]) => !incoming.has(relative))) : saved.files;
      const root = await safePath(path.join(cacheRoot, name));
      const present = await metadata(root, { entries: 0, bytes: 0 });
      for (const [relative, mode] of present.directories) {
        if (target && (payloadDirectories.has(relative) || !saved.directories.has(relative))) continue;
        if (!saved.directories.has(relative) || mode !== saved.directories.get(relative)) throw invalid();
      }
      for (const [relative, record] of present.files) {
        if (target && !retainedFiles.has(relative)) continue;
        if (record.mode !== retainedFiles.get(relative)?.mode || !retainedFiles.get(relative)?.bytes.equals(await bytes(record))) {
          throw refusal("An active Decision cache changed during installation; its rollback was retained");
        }
      }
      const created = [];
      for (const [relative, mode] of saved.directories) {
        if (present.directories.has(relative)) continue;
        const directory = await safePath(path.join(root, relative));
        try {
          await fs.mkdir(directory, { mode: mode | 0o700, recursive: !relative });
          created.push([directory, mode]);
        } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      for (const [relative, record] of retainedFiles) {
        if (present.files.has(relative)) continue;
        const filename = await safePath(path.join(root, relative));
        let file;
        try { file = await fs.open(filename, "wx", record.mode); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const stat = await fs.lstat(await safePath(filename));
          if (!stat.isFile() || stat.size > LIMITS.file || (stat.mode & 0o777) !== record.mode ||
              !(await bytes({ filename, size: stat.size })).equals(record.bytes)) throw invalid();
          continue;
        }
        try {
          await file.writeFile(record.bytes);
          if (process.platform !== "win32") await file.chmod(record.mode);
          await file.sync();
        } finally { await file.close(); }
      }
      if (process.platform !== "win32") for (const [directory, mode] of created.reverse()) await fs.chmod(directory, mode);
    }
  }
  return { snapshot, backup, restore, readFile };
};
