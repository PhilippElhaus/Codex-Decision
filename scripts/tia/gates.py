"""Run mandatory boundary checks with fresh repository-owned output paths."""
import argparse
import uuid

from common import ROOT, command

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("gate", choices=["quality", "browser"])
args = parser.parse_args()
output = ROOT / ".local/quality" / ("tia-" + str(uuid.uuid4()))
if args.gate == "quality":
    command(["cargo", "build", "--locked", "-p", "codex-decision", "--profile", "verification"])
    import os
    from pathlib import Path
    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / ".cache/cargo"))
    hook = target / "verification" / ("decision-hook.exe" if os.name == "nt" else "decision-hook")
    command(["node", "scripts/dummy_matrix.cjs", "--hook", hook, "--jobs", "2", "--out", output / "matrix"])
    for runner, flags in [("pipeline_interrupt.cjs", []),
                          ("pipeline_stage_interrupt.cjs", ["--require-recovered"]),
                          ("pipeline_stage_interrupt.cjs", ["--concurrent-rollback"]),
                          ("pipeline_commit_interrupt.cjs", [])]:
        command(["node", "scripts/" + runner, "--hook", hook, *flags,
                 "--out", output / str(uuid.uuid4())])
else:
    import sys
    command([sys.executable, "vscode-control/scripts/browser_smoke.py", "--browser", "chromium"])
    command([sys.executable, "vscode-control/scripts/browser_quality.py", "--rounds", "50", "--seed", "7",
             "--fallback-every", "5", "--out", output])
