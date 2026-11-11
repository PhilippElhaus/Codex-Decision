"""Rust per-test function coverage using the active toolchain's LLVM tools."""
import json
import os
from pathlib import Path
import re

from common import ROOT, command, temporary_directory


def artifacts(env=None):
    result = command(["cargo", "test", "--locked", "-p", "codex-decision", "--no-run",
                      "--message-format=json"], env=env, capture_output=True)
    tests, objects = [], set()
    for line in result.stdout.splitlines():
        event = json.loads(line)
        executable = event.get("executable")
        if not executable:
            continue
        objects.add(executable)
        if event.get("profile", {}).get("test"):
            kind = event["target"]["kind"][0]
            if kind in {"lib", "bin", "test"}:
                tests.append({"target": event["target"]["name"], "kind": kind, "executable": executable})
    if not tests:
        raise RuntimeError("Cargo returned no test executables")
    return tests, sorted(objects)


def llvm_tools():
    sysroot = Path(command(["rustc", "--print", "sysroot"], capture_output=True).stdout.strip())
    host = re.search(r"^host: (.+)$", command(["rustc", "-vV"], capture_output=True).stdout, re.M)[1]
    suffix = ".exe" if os.name == "nt" else ""
    tools = [sysroot / "lib/rustlib" / host / "bin" / (name + suffix)
             for name in ["llvm-profdata", "llvm-cov"]]
    if not all(path.is_file() for path in tools):
        raise RuntimeError("Install llvm-tools-preview for the active Rust toolchain before collecting Rust coverage")
    return tools


def collect():
    profdata, cov = llvm_tools()
    cache = Path.home() / ".cache/codex-decision/tia-target"
    env = dict(os.environ, CARGO_TARGET_DIR=str(cache),
               RUSTFLAGS=os.environ.get("RUSTFLAGS", "") + " -C instrument-coverage")
    with temporary_directory("decision-tia-rust-") as directory:
        temporary = Path(directory)
        env["LLVM_PROFILE_FILE"] = str(temporary / "%p-%m.profraw")
        targets, objects = artifacts(env)
        tests = []
        combined = temporary / "all.profdata"
        for target in targets:
            listing = command([target["executable"], "--list", "--format", "terse"],
                              env=env, capture_output=True).stdout
            ignored = command([target["executable"], "--list", "--ignored", "--format", "terse"],
                              env=env, capture_output=True).stdout
            ignored_names = set(re.findall(r"^(.+): test$", ignored, re.M))
            for name in re.findall(r"^(.+): test$", listing, re.M):
                if name in ignored_names:
                    continue
                for raw in temporary.glob("*.profraw"):
                    raw.unlink()
                print(f"Rust coverage: {target['target']}::{name}", flush=True)
                command([target["executable"], name, "--exact", "--quiet"], env=env)
                raw = sorted(temporary.glob("*.profraw"))
                if not raw:
                    raise RuntimeError(f"No LLVM evidence for {name}")
                single = temporary / "one.profdata"
                command([profdata, "merge", "-sparse", *raw, "-o", single], capture_output=True)
                detail = command([profdata, "show", "--covered", "--all-functions", single], capture_output=True).stdout
                # Recent LLVM --covered emits one mangled name per line.
                # Older versions indent names and append a colon.
                symbols = [line.strip().removesuffix(":") for line in detail.splitlines()
                           if line.strip().startswith(("_R", "_Z"))]
                if not symbols:
                    raise RuntimeError("LLVM did not return covered function identities")
                tests.append({"id": f"{target['kind']}:{target['target']}::{name}",
                              "target": target["target"], "kind": target["kind"], "name": name, "symbols": symbols})
                pending = temporary / "merged.profdata"
                inputs = [combined, single] if combined.exists() else [single]
                command([profdata, "merge", "-sparse", *inputs, "-o", pending], capture_output=True)
                pending.replace(combined)
        args = [cov, "export", objects[0], f"-instr-profile={combined}", "--skip-expansions"]
        for obj in objects[1:]:
            args.extend(["-object", obj])
        exported = json.loads(command(args, capture_output=True).stdout)
        functions, symbols, paths = {}, {}, {}
        for data in exported["data"]:
            for function in data["functions"]:
                locations = {}
                for region in function["regions"]:
                    filename = function["filenames"][region[5]]
                    if filename not in paths:
                        try:
                            paths[filename] = Path(filename).resolve().relative_to(ROOT).as_posix()
                        except ValueError:
                            paths[filename] = ""
                    relative = paths[filename]
                    if not relative.endswith(".rs"):
                        continue
                    span = locations.setdefault(relative, [region[0], region[2]])
                    span[0], span[1] = min(span[0], region[0]), max(span[1], region[2])
                symbols.setdefault(function["name"], []).append(locations)
                for filename, span in locations.items():
                    if span not in functions.setdefault(filename, []):
                        functions[filename].append(span)
        for test in tests:
            spans = {}
            for symbol in test.pop("symbols"):
                for locations in symbols.get(symbol, []):
                    for filename, span in locations.items():
                        if span not in spans.setdefault(filename, []):
                            spans[filename].append(span)
            test["spans"] = spans
        if not functions or not any(t["spans"] for t in tests):
            raise RuntimeError("LLVM function/source mapping is empty")
        # libtest discovery does not include rustdoc examples. Keep that
        # separate native boundary complete, without claiming case coverage.
        command(["cargo", "test", "--locked", "-p", "codex-decision", "--doc"])
        return tests, functions


def run_selected(tests):
    targets, _ = artifacts()
    binaries = {(t["kind"], t["target"]): t["executable"] for t in targets}
    # A changed test declaration can rename a case. libtest exits successfully
    # for an unmatched filter, so validate every identity before running any.
    identities = {}
    for key in {(t["kind"], t["target"]) for t in tests}:
        binary = binaries.get(key)
        if not binary:
            command(["cargo", "test", "--locked", "-p", "codex-decision"])
            return
        listing = command([binary, "--list", "--format", "terse"], capture_output=True).stdout
        identities[key] = set(re.findall(r"^(.+): test$", listing, re.M))
    if any(t["name"] not in identities[(t["kind"], t["target"])] for t in tests):
        command(["cargo", "test", "--locked", "-p", "codex-decision"])
        return
    for test in tests:
        executable = binaries[(test["kind"], test["target"])]
        command([executable, test["name"], "--exact"])
    command(["cargo", "test", "--locked", "-p", "codex-decision", "--doc"])
