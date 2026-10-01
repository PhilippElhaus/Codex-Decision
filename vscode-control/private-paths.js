"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

function wslLocation(filename) {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([A-Za-z0-9_-]+)\\(.+)$/i.exec(filename);
  return match ? { distro: match[1], filename: `/${match[2].replaceAll("\\", "/")}` } : null;
}

// Windows mkdir/write mode flags do not reach the WSL filesystem through UNC.
// Open each Linux component without following links, then restrict the owned inode.
const restrictScript = `import os, stat, sys
parts = sys.argv[1].split('/')[1:]
if not parts or any(p in ('', '.', '..') for p in parts):
    raise ValueError('invalid private path')
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
fd = os.open('/', flags)
try:
    for part in parts[:-1]:
        next_fd = os.open(part, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    target = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if sys.argv[2] == 'directory' else 0), dir_fd=fd)
    try:
        info = os.fstat(target)
        if info.st_uid != os.geteuid() or not (stat.S_ISDIR(info.st_mode) if sys.argv[2] == 'directory' else stat.S_ISREG(info.st_mode)):
            raise ValueError('invalid private inode')
        os.fchmod(target, 0o700 if sys.argv[2] == 'directory' else 0o600)
    finally:
        os.close(target)
finally:
    os.close(fd)
`;

async function restrictWslPath(filename, directory, run = runFile, platform = process.platform) {
  if (platform !== "win32") return;
  const location = wslLocation(filename);
  if (!location) return;
  try {
    await run("wsl.exe", ["-d", location.distro, "-e", "python3", "-c", restrictScript,
      location.filename, directory ? "directory" : "file"], { timeout: 10_000, maxBuffer: 4096 });
  } catch {
    throw new Error("Could not secure Jev state in WSL");
  }
}

module.exports = { wslLocation, restrictWslPath };
