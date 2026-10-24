"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureIntegratedInstall } = require("../../vscode-control/integrated-install");

async function fixture(operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "decision-integrated-test-"));
  try {
    const manifest = path.join(root, "plugin", ".codex-plugin", "plugin.json");
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, "{}");
    return await operation(root);
  } finally { await fs.rm(root, { recursive: true }); }
}

function vscodeStub(root, wsl = true) {
  const updates = [];
  return {
    updates, ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: () => ({ extensionPath: path.join(root, "Codex host with spaces") }) },
    workspace: { getConfiguration: (section) => section === "chatgpt" ? { get: () => wsl }
      : { update: async (...args) => { updates.push(args); } } },
  };
}

const installed = { status: "ready", dataDirectory: "/home/alex/.codex/plugins/data/codex-decision-personal",
  decisionctl: "/home/alex/.codex/plugins/cache/personal/codex-decision/1.0.0/hooks/bin/linux-x86_64/decisionctl" };

test("integrated install discovers storage only when the setting is blank", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: JSON.stringify(installed) }; };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "linux", run });
  assert.equal(result.status, "ready");
  assert.deepEqual(vscode.updates, [["dataDirectory", installed.dataDirectory, 1]]);
  assert.equal(calls[0][0], "python3");
  assert.ok(calls[0][1].includes(path.join(root, "Codex host with spaces", "bin", "linux-x86_64", "codex")));
  vscode.updates.length = 0;
  await ensureIntegratedInstall(vscode, { extensionPath: root },
    { platform: "linux", run, dataDirectory: installed.dataDirectory });
  assert.deepEqual(vscode.updates, []);
  assert.deepEqual(calls[1][1].slice(-2), ["--data-directory", installed.dataDirectory]);
}));

test("Windows bootstrap selects the configured WSL distribution and passes each path as an argument", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const calls = [];
  const configured = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal";
  const run = async (binary, args) => {
    calls.push({ binary, args });
    if (args[3] === "wslpath") return { stdout: `/mnt/c/converted/${path.basename(args[5])}\n` };
    return { stdout: JSON.stringify(installed) };
  };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root },
    { platform: "win32", run, dataDirectory: configured });
  assert.equal(result.distro, "Ubuntu-24.04");
  assert.equal(result.dataDirectory, configured);
  assert.ok(calls.every(({ binary, args }) => binary === "wsl.exe" && args[0] === "-d" && args[1] === "Ubuntu-24.04"));
  const install = calls.find(({ args }) => args[3] === "python3");
  assert.deepEqual(install.args.slice(-2), ["--data-directory", installed.dataDirectory]);
  assert.deepEqual(vscode.updates, []);
}));

test("Windows fresh bootstrap discovers default WSL and stores the matching UNC path", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const run = async (_binary, args) => {
    if (args[0] === "-e") return { stdout: "Ubuntu-24.04\n" };
    if (args[3] === "wslpath") return { stdout: `/mnt/c/converted/${path.basename(args[5])}\n` };
    return { stdout: JSON.stringify(installed) };
  };
  await ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "win32", run });
  assert.deepEqual(vscode.updates, [["dataDirectory",
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal", 1]]);
}));

test("native Windows installs without probing WSL even when a distribution is installed", async () => fixture(async (root) => {
  const vscode = vscodeStub(root, false);
  const native = { status: "installed", dataDirectory: "C:\\Users\\alex\\.codex\\plugins\\data\\codex-decision-integrated",
    decisionctl: "C:\\Users\\alex\\.codex\\plugins\\cache\\decisionctl.exe" };
  let input;
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root }, {
    platform: "win32", run: async () => { throw new Error("WSL must not run"); },
    installNative: async (options) => { input = options; return native; },
  });
  assert.equal(result.backend, "native");
  assert.equal(result.distro, null);
  assert.equal(input.payload, path.join(root, "plugin"));
  assert.equal(input.codex, path.join(root, "Codex host with spaces", "bin", "windows-x86_64", "codex.exe"));
  assert.deepEqual(vscode.updates, [["dataDirectory", native.dataDirectory, 1]]);
  vscode.updates.length = 0;
  await ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "win32",
    dataDirectory: native.dataDirectory, installNative: async (options) => {
      assert.equal(options.dataDirectory, native.dataDirectory); return native;
    } });
  assert.deepEqual(vscode.updates, []);
}));

test("native Codex refuses a stale WSL setting before writing either environment", async () => fixture(async (root) => {
  for (const configured of ["/home/alex/.codex/plugins/data/decision", "\\\\wsl.localhost\\Ubuntu\\home\\alex\\decision", "C:relative"]) {
    await assert.rejects(ensureIntegratedInstall(vscodeStub(root, false), { extensionPath: root }, {
      platform: "win32", dataDirectory: configured,
      run: async () => { throw new Error("must not run WSL"); },
      installNative: async () => { throw new Error("must not install"); },
    }), /Codex runs in Windows/);
  }
}));

test("a Windows UI host in a Remote WSL window follows Codex's native runtime selection", async () => fixture(async (root) => {
  const vscode = vscodeStub(root, true);
  vscode.env = { remoteName: "wsl" };
  const native = { status: "ready", dataDirectory: "C:\\Users\\alex\\.codex\\plugins\\data\\decision",
    decisionctl: "C:\\Users\\alex\\decisionctl.exe" };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root }, {
    platform: "win32", run: async () => { throw new Error("must not launch WSL"); },
    installNative: async () => native,
  });
  assert.equal(result.backend, "native");
  assert.equal(result.dataDirectory, native.dataDirectory);
}));

test("automatically managed storage follows native and WSL runtime switches without migrating data", async () => fixture(async (root) => {
  const vscode = vscodeStub(root, false);
  const values = new Map();
  const context = { extensionPath: root, globalState: {
    get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); },
  } };
  const native = { status: "ready", dataDirectory: "C:\\Users\\alex\\.codex\\plugins\\data\\decision",
    decisionctl: "C:\\Users\\alex\\decisionctl.exe" };
  let directory;
  let wsl = false;
  const getConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (section) => section === "chatgpt" ? { get: () => wsl } : {
    update: async (...args) => { directory = args[1]; await getConfiguration(section).update(...args); },
  };
  let nativeInstalls = 0;
  const options = { platform: "win32", dataDirectory: () => directory,
    installNative: async (input) => {
      nativeInstalls += 1;
      assert.equal(input.dataDirectory, undefined, "another runtime's location must not enter the native installer");
      return native;
    },
    run: async (_binary, args) => {
      assert.equal(wsl, true, "native mode must not invoke WSL");
      if (args[0] === "-e") return { stdout: "Ubuntu\n" };
      if (args[3] === "wslpath") return { stdout: "/mnt/c/converted\n" };
      assert.equal(args.includes("--data-directory"), false,
        "another runtime's location must not enter the WSL installer");
      return { stdout: JSON.stringify(installed) };
    },
  };
  assert.equal((await ensureIntegratedInstall(vscode, context, options)).backend, "native");
  assert.equal(directory, native.dataDirectory);
  wsl = true;
  assert.equal((await ensureIntegratedInstall(vscode, context, options)).backend, "wsl");
  assert.match(directory, /^\\\\wsl\.localhost\\Ubuntu\\/);
  wsl = false;
  assert.equal((await ensureIntegratedInstall(vscode, context, options)).backend, "native");
  assert.equal(directory, native.dataDirectory);
  assert.equal(nativeInstalls, 2);
  assert.equal(vscode.updates.length, 3);
  assert.deepEqual([...values.values()], [{ dataDirectory: native.dataDirectory, backend: "native" }]);

  directory = "\\\\wsl$\\ExplicitOverride\\home\\alex\\decision";
  await assert.rejects(ensureIntegratedInstall(vscode, context, options), /Codex runs in Windows/);
  assert.equal(nativeInstalls, 2, "an explicit override must remain visible before installation");
  assert.equal(vscode.updates.length, 3, "an explicit override must not be replaced");
}));

test("a verified canonical legacy WSL location joins automatic switching after successful repair", async () => fixture(async (root) => {
  for (const prefix of ["\\\\wsl$\\Ubuntu", "//wsl.localhost/Ubuntu"]) {
    const values = new Map();
    const context = { extensionPath: root, globalState: {
      get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); },
    } };
    const configured = prefix + installed.dataDirectory.replaceAll("/", prefix.startsWith("//") ? "/" : "\\");
    const vscode = vscodeStub(root, true);
    await ensureIntegratedInstall(vscode, context, { platform: "win32", dataDirectory: configured,
      run: async (_binary, args) => {
        if (args[3] === "wslpath") return { stdout: "/mnt/c/converted\n" };
        assert.deepEqual(args.slice(-2), ["--data-directory", installed.dataDirectory]);
        return { stdout: JSON.stringify(installed) };
      },
    });
    assert.deepEqual([...values.values()], [{ dataDirectory: configured, backend: "wsl" }]);
    assert.deepEqual(vscode.updates, [], "adoption must preserve the existing equivalent UNC alias");
    const native = { status: "ready", dataDirectory: "C:\\Users\\alex\\.codex\\plugins\\data\\decision",
      decisionctl: "C:\\Users\\alex\\decisionctl.exe" };
    const switched = await ensureIntegratedInstall(vscodeStub(root, false), context, {
      platform: "win32", dataDirectory: configured,
      run: async () => { throw new Error("native switching must not invoke WSL"); },
      installNative: async (input) => {
        assert.equal(input.dataDirectory, undefined); return native;
      },
    });
    assert.equal(switched.backend, "native");
    assert.equal(switched.dataDirectory, native.dataDirectory);
  }
}));

test("a mismatched legacy override cannot acquire automatic storage ownership", async () => fixture(async (root) => {
  const values = new Map();
  const context = { extensionPath: root, globalState: {
    get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); },
  } };
  const vscode = vscodeStub(root, true);
  await assert.rejects(ensureIntegratedInstall(vscode, context, { platform: "win32",
    dataDirectory: "\\\\wsl$\\Ubuntu\\home\\alex\\custom-override",
    run: async (_binary, args) => {
      if (args[3] === "wslpath") return { stdout: "/mnt/c/converted\n" };
      throw Object.assign(new Error("installer refusal"), { stdout: JSON.stringify({ status: "error",
        error: "Decision dataDirectory does not match the active Codex plugin; correct it before repair" }) });
    },
  }), /dataDirectory does not match/);
  assert.equal(values.size, 0);
  assert.deepEqual(vscode.updates, []);
}));

test("a Linux data setting becomes a readable UNC path in the selected WSL environment", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  const run = async (_binary, args) => {
    if (args[0] === "-e") return { stdout: "Ubuntu-24.04\n" };
    if (args[3] === "wslpath") return { stdout: "/mnt/c/converted\n" };
    assert.deepEqual(args.slice(-2), ["--data-directory", installed.dataDirectory]);
    return { stdout: JSON.stringify(installed) };
  };
  const result = await ensureIntegratedInstall(vscode, { extensionPath: root }, {
    platform: "win32", run, dataDirectory: installed.dataDirectory,
  });
  assert.equal(result.backend, "wsl");
  assert.equal(result.dataDirectory, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal");
  assert.deepEqual(vscode.updates, [["dataDirectory", result.dataDirectory, 1]]);
}));

test("WSL rejects malformed path conversion results before running the installer", async () => fixture(async (root) => {
  for (const output of ["relative", "/tmp/../elsewhere", "/tmp/converted\n/private/path", ""]) {
    let installations = 0;
    await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, {
      platform: "win32", dataDirectory: "\\\\wsl.localhost\\Ubuntu\\home\\alex\\decision",
      run: async (_binary, args) => {
        if (args[3] === "python3") installations += 1;
        return { stdout: output };
      },
    }), /could not be converted/);
    assert.equal(installations, 0);
  }
}));

test("installer errors cannot copy raw subprocess diagnostics into the control", async () => fixture(async (root) => {
  const vscode = vscodeStub(root);
  await assert.rejects(ensureIntegratedInstall(vscode, { extensionPath: root }, { platform: "linux",
    run: async () => { throw Object.assign(new Error("unrelated diagnostics"),
      { stdout: JSON.stringify({ status: "error", error: "Decision dataDirectory does not match the active Codex plugin; correct it before repair" }) }); } }),
  /dataDirectory does not match/);
  assert.deepEqual(vscode.updates, []);
}));

test("only an explicit transient installer failure authorizes automatic recovery", async () => fixture(async (root) => {
  for (const retryable of [true, false, "true", undefined]) {
    await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, { platform: "linux",
      run: async () => { throw Object.assign(new Error("private subprocess details"), {
        stdout: JSON.stringify({ status: "error", error: "sanitized installation failure", retryable }),
        stderr: "private environment must not appear" }); } }), (error) => {
      assert.equal(error.message, "sanitized installation failure");
      assert.equal(error.retryable, retryable === true);
      return true;
    });
  }
}));

test("temporary WSL discovery, path conversion, and installer transport failures stay retryable", async () => fixture(async (root) => {
  const configured = "\\\\wsl.localhost\\Ubuntu\\home\\alex\\.codex\\plugins\\data\\codex-decision-personal";
  for (const phase of ["discovery", "conversion", "installation"]) {
    for (const cause of [{ code: "EAGAIN" }, { code: "ETIMEDOUT" }, { code: null, killed: true, signal: "SIGTERM" }]) {
      await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, {
        platform: "win32", dataDirectory: phase === "discovery" ? "" : configured,
        run: async (_program, args) => {
          const actual = args[0] === "-e" ? "discovery" : args[3] === "wslpath" ? "conversion" : "installation";
          if (actual === phase) throw Object.assign(new Error("private process arguments"), {
            ...cause, stdout: "private stdout", stderr: "private stderr" });
          if (actual === "discovery") return { stdout: "Ubuntu\n" };
          if (actual === "conversion") return { stdout: "/mnt/c/converted\n" };
          return { stdout: JSON.stringify(installed) };
        },
      }), (error) => {
        assert.equal(error.retryable, true);
        const label = phase === "discovery" ? "WSL discovery" : phase === "conversion" ? "WSL path conversion" : "hook installer";
        assert.equal(error.message, `Decision installation is temporarily unavailable during ${label}; check WSL availability`);
        return true;
      });
    }
  }
}));

test("deterministic WSL discovery and conversion failures discard raw process diagnostics", async () => fixture(async (root) => {
  for (const phase of ["discovery", "conversion"]) {
    for (const code of [1, "ENOENT", "EACCES"]) {
      await assert.rejects(ensureIntegratedInstall(vscodeStub(root), { extensionPath: root }, {
        platform: "win32", dataDirectory: phase === "discovery" ? "" : "\\\\wsl.localhost\\Ubuntu\\home\\alex\\data",
        run: async () => { throw Object.assign(new Error("private process arguments"), {
          code, stdout: "private stdout", stderr: "private stderr", env: { KEY: "private key" } }); },
      }), (error) => {
        const label = phase === "discovery" ? "WSL discovery" : "WSL path conversion";
        assert.equal(error.message, `Decision installation failed during ${label}; check WSL availability and file access`);
        assert.notEqual(error.retryable, true);
        assert.equal(error.stdout, undefined);
        assert.equal(error.stderr, undefined);
        return true;
      });
    }
  }
}));

test("source-only test activation does not install a hook", async () => {
  const result = await ensureIntegratedInstall({}, { extensionUri: {} },
    { run: async () => { throw new Error("must not run"); } });
  assert.deepEqual(result, { status: "not-packaged" });
});
