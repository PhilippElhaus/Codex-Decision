"""Codex command-hook adapter. Writes only Codex hook JSON to stdout."""

import json
import os
from pathlib import Path
import sys

from pilot import Config, Result, append_log, decide, jev_request


def main() -> None:
    try:
        data_dir = Path(os.environ["PLUGIN_DATA"])
        config = Config.from_file(data_dir / "config.json")
        if not config.enabled:
            print("{}")
            return
        payload = sys.stdin.read(5_000_001)
        if len(payload) > 5_000_000:
            print("{}")
            return
        event = json.loads(payload)
        def evaluate(state, settings):
            try:
                append_log(data_dir, Result("calling", "jev_request"), str(event.get("tool_name", "")))
            except OSError:
                pass
            return jev_request(state, settings, "")

        outcome = decide(event, config, evaluator=evaluate, storage=data_dir)
        try:
            append_log(data_dir, outcome, str(event.get("tool_name", "")))
        except OSError:
            pass
        print(json.dumps(outcome.hook_output or {}, ensure_ascii=False))
    except Exception:
        # A malformed event, config, or API outage must keep the original result.
        print("{}")


if __name__ == "__main__":
    main()
