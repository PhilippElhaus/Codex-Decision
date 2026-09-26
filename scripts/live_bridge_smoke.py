"""Exercise a Jev hook with a real request and no key in WSL."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from replay import generated_cases


SOURCE = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hook-script', type=Path, default=SOURCE / 'hooks/post_tool_use.py')
    args = parser.parse_args()
    hook = args.hook_script.resolve(strict=True)
    event = next(generated_cases(1))['event']
    environment = dict(os.environ)
    environment.pop('TYPESAFE_API_KEY', None)
    with tempfile.TemporaryDirectory(prefix='codex-jev-e2e-', dir='/tmp') as directory:
        data = Path(directory)
        environment['PLUGIN_DATA'] = directory

        def invoke() -> dict:
            result = subprocess.run(
                ['python3', str(hook)], input=json.dumps(event), text=True,
                capture_output=True, timeout=7, env=environment, check=True,
            )
            if result.stderr:
                raise RuntimeError('hook wrote to stderr')
            return json.loads(result.stdout)

        (data / 'config.json').write_text('{"enabled":false,"mode":"observe"}', encoding='utf-8')
        if invoke() != {} or (data / 'events.jsonl').exists():
            raise AssertionError('disabled hook made a decision')

        (data / 'config.json').write_text('{"enabled":true,"mode":"observe"}', encoding='utf-8')
        if invoke() != {}:
            raise AssertionError('observe mode changed tool output')
        events = [json.loads(line) for line in (data / 'events.jsonl').read_text().splitlines()]
        if len(events) != 2 or events[0]['status'] != 'calling' or events[1]['reason'] not in ('observe', 'jev_keep'):
            raise AssertionError(f'unexpected live decision: {events}')
        if not isinstance(events[1]['scores'], dict) or set(events[1]['scores']) != {
            'routine_noise', 'needs_exact_text', 'one_off_value'
        }:
            raise AssertionError('real Jev scores missing')
        if list(data.rglob('*.txt')):
            raise AssertionError('observe mode saved replacement output')
        (data / 'config.json').write_text('{"enabled":true,"mode":"replace"}', encoding='utf-8')
        environment['TYPESAFE_API_KEY'] = 'deliberately-invalid-stale-test-key'
        replacement = invoke()
        final_events = [json.loads(line) for line in (data / 'events.jsonl').read_text().splitlines()]
        originals = list(data.rglob('*.txt'))
        if replacement.get('continue') is not False or final_events[-1]['reason'] != 'jev_replace':
            raise AssertionError(f'live replacement failed: {final_events[-1]}')
        if len(originals) != 1 or originals[0].read_text() != event['tool_response']:
            raise AssertionError('saved original differs from actual tool result')
        print(json.dumps({'key_in_wsl_env': False, 'disabled': 'skipped',
                          'live_status': events[1]['status'], 'live_reason': events[1]['reason'],
                          'real_jev_scores': True, 'stale_wsl_env_ignored': True,
                          'replace_saved_exact_original': True}))


if __name__ == '__main__':
    main()
