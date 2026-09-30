#!/usr/bin/env python3
"""Check the installed Jev hook through Codex's read-only hooks/list API."""

import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time


def list_hooks(cwd: Path, timeout: float = 30) -> dict:
    process = subprocess.Popen(
        ["codex", "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        messages = [
            {"method": "initialize", "id": 1, "params": {"clientInfo": {
                "name": "codex_jev_trust_check", "title": "Codex Jev Trust Check", "version": "0.1.0"}}},
            {"method": "initialized", "params": {}},
            {"method": "hooks/list", "id": 2, "params": {"cwds": [str(cwd)]}},
        ]
        process.stdin.write(("\n".join(json.dumps(message) for message in messages) + "\n").encode())
        process.stdin.flush()
        pending = b""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            if len(pending) > 2_000_000:
                raise RuntimeError("Codex hook status response is too large")
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                response = json.loads(line)
                if response.get("id") == 2:
                    if "error" in response or not isinstance(response.get("result"), dict):
                        raise RuntimeError("Codex could not list hooks")
                    return response["result"]
        raise RuntimeError("Codex did not return hook status")
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def jev_status(result: dict, plugin_id: str | None) -> tuple[str, str]:
    entries = result.get("data")
    if not isinstance(entries, list):
        raise RuntimeError("Codex returned invalid hook status")
    hooks = [hook for entry in entries for hook in entry.get("hooks", [])
             if hook.get("source") == "plugin" and hook.get("eventName") == "postToolUse"
             and (hook.get("pluginId") == plugin_id if plugin_id else
                  str(hook.get("pluginId", "")).startswith("codex-jev@"))]
    if len(hooks) != 1:
        raise RuntimeError("Expected one installed Jev PostToolUse hook; use --plugin-id if needed")
    hook = hooks[0]
    if hook.get("handlerType") != "command":
        raise RuntimeError("Jev PostToolUse is not a command hook")
    if not hook.get("enabled"):
        return str(hook["pluginId"]), "disabled"
    return str(hook["pluginId"]), str(hook.get("trustStatus", "unknown"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--plugin-id", help="Exact installed plugin ID, such as codex-jev@personal")
    args = parser.parse_args()
    try:
        plugin_id, status = jev_status(list_hooks(args.cwd.resolve()), args.plugin_id)
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print(f"Codex Jev hook check failed: {error}", file=sys.stderr)
        return 1
    if status != "trusted":
        print(f"{plugin_id} PostToolUse is {status}. Open /hooks in Codex, review and trust it, "
              "then start a new thread and rerun this check.", file=sys.stderr)
        return 1
    print(f"{plugin_id} PostToolUse is trusted and enabled.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
