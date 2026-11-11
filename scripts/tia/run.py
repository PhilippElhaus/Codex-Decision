#!/usr/bin/env python3
"""Run native tests from per-test function evidence, or the complete suite."""
import argparse
import json
import sys

from common import command, inventory, load, prepare_native_cli, save, select


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("family", choices=["node", "python", "rust"])
    parser.add_argument("--collect", action="store_true", help="Run the complete suite and replace function evidence")
    parser.add_argument("--full", action="store_true", help="Run the complete native suite without collecting")
    parser.add_argument("--plan", action="store_true", help="Print the selection without executing tests")
    args = parser.parse_args()
    if args.family == "node":
        prepare_native_cli()
    current = inventory()
    if args.collect:
        if args.plan or args.full:
            parser.error("--collect cannot be combined with --plan or --full")
        if args.family == "node":
            from node import collect
        elif args.family == "python":
            from python_coverage import collect
        else:
            from rust import collect
        tests, functions = collect()
        if current != inventory():
            raise RuntimeError("Source changed during collection; baseline was not updated")
        save(args.family, current, tests, functions)
        print(f"Recorded {len(tests)} {args.family} test functions", flush=True)
        return
    try:
        plan = select(args.family, load(args.family), current)
    except (KeyError, TypeError, ValueError, AttributeError, IndexError):
        plan = {"mode": "full", "reason": "invalid coverage manifest", "tests": []}
    if args.full:
        plan = {"mode": "full", "reason": "complete suite requested", "tests": []}
    print(json.dumps({"family": args.family, **plan,
                      "tests": [t["id"] for t in plan["tests"]]}, indent=2), flush=True)
    if args.plan:
        return
    if plan["mode"] == "full":
        commands = {"node": ["node", "scripts/node_tests.cjs"],
                    "python": [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
                    "rust": ["cargo", "test", "--locked", "-p", "codex-decision"]}
        command(commands[args.family])
    elif plan["tests"]:
        if args.family == "node":
            from node import run_selected
            run_selected(plan["tests"])
        elif args.family == "python":
            command([sys.executable, "-m", "unittest", *[t["id"] for t in plan["tests"]]])
        else:
            from rust import run_selected
            run_selected(plan["tests"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"TIA failed: {error}", file=sys.stderr)
        sys.exit(1)
