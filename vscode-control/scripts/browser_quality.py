"""Stress the real composer and render hook-produced panel snapshots with synthetic data."""

import argparse
import json
import math
from pathlib import Path
import random
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]

INSTRUMENT = """() => {
  window.__jevLayout = {calls: 0, ms: [], textNodes: 0};
  const timeout = window.setTimeout;
  window.setTimeout = function(callback, delay, ...args) {
    if (typeof callback === 'function' && callback.toString().includes('positionScheduled = false')) {
      const position = callback;
      callback = () => {
        const before = performance.now();
        position();
        window.__jevLayout.calls += 1;
        window.__jevLayout.ms.push(performance.now() - before);
      };
    }
    return timeout.call(this, callback, delay, ...args);
  };
  const next = TreeWalker.prototype.nextNode;
  TreeWalker.prototype.nextNode = function() {
    const node = next.call(this);
    if (node) window.__jevLayout.textNodes += 1;
    return node;
  };
}"""

GEOMETRY = """() => {
  const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
  return {access: rect('.access'), model: rect('.model'), button: rect('#codex-jev-button'),
    dot: rect('#codex-jev-dot'), visible: document.getElementById('codex-jev').style.display !== 'none'};
}"""


def composer_round(page, rng, benchmark=False):
    width = rng.choice([360, 480, 720, 1200, 1600, 2800])
    gap = rng.choice([48, 80, 120] if benchmark else [8, 12, 14, 20, 24, 28, 30, 48, 80, 120])
    page.set_viewport_size({'width': width, 'height': 600})
    page.evaluate("""({gap, height, label}) => {
      document.querySelector('.toolbar').style.gap = gap + 'px';
      document.querySelector('.access').textContent = label;
      const model = document.querySelector('.model');
      model.style.marginLeft = '0';
      model.style.height = height + 'px';
      model.textContent = 'GPT-6.1 Sol Extra High';
      window.dispatchEvent(new Event('resize'));
    }""", {'gap': gap, 'height': rng.choice([28, 30, 34, 38, 44]),
            'label': rng.choice(['Full access', 'Workspace write', 'Read-only'])})
    page.wait_for_function("""() => {
      const root = document.getElementById('codex-jev');
      const a = document.querySelector('.access').getBoundingClientRect();
      const m = document.querySelector('.model').getBoundingClientRect();
      const b = document.getElementById('codex-jev-button').getBoundingClientRect();
      return m.left - a.right < 11 ? root.style.display === 'none' :
        root.style.display === 'block' && Math.abs(b.top + b.height / 2 - a.top - a.height / 2) <= 1 &&
        b.left >= a.right + 1 && b.right <= m.left - 1;
    }""")
    geometry = page.evaluate(GEOMETRY)
    if geometry['visible']:
        assert geometry['dot']['width'] == 7, geometry
    return {'width': width, 'gap': gap, 'visible': geometry['visible']}


def panel_round(page, snapshot, round_number, width):
    page.set_viewport_size({'width': width, 'height': 600})
    payload = {**snapshot, 'id': f'{round_number:032x}'}
    before = time.perf_counter()
    page.evaluate("""decision => window.dispatchEvent(new MessageEvent('message', {
      data: {type: 'decision', decision}
    }))""", payload)
    report = page.evaluate("""() => ({rows: document.querySelectorAll('.batch-row').length,
      title: document.querySelector('.batch-title').textContent,
      overflow: document.documentElement.scrollWidth > innerWidth + 1})""")
    assert report['rows'] == len(snapshot['rows']), report
    assert not report['overflow'], report
    return round((time.perf_counter() - before) * 1000, 3)


def panel_settled(page, snapshot):
    page.wait_for_function("""() => [...document.querySelectorAll('.batch-value')]
      .every(value => Number(getComputedStyle(value).opacity) === 1)""")
    report = page.evaluate("""() => [...document.querySelectorAll('.batch-row')].map(row => ({
      score: Number(row.querySelector('.batch-value').textContent),
      width: parseFloat(row.querySelector('.batch-bar-fill').style.width)
    }))""")
    for row, actual in zip(snapshot['rows'], report):
        score = row['retention_index']
        assert actual['score'] == float(f'{score:.2f}'), actual
        expected_width = max(score, .04) if row['action'] == 'omit' else score
        assert abs(actual['width'] - expected_width * 100) <= .011, actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rounds', type=int, default=30)
    parser.add_argument('--minutes', type=float, default=0)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--panel', type=Path, action='append', help='Normalized snapshot; repeat to rotate snapshots')
    parser.add_argument('--control', type=Path, help='Optional baseline composer script')
    parser.add_argument('--benchmark-only', action='store_true', help='Use gaps supported by the baseline')
    parser.add_argument('--settle-every', type=int, default=100, help='Verify completed panel animations every N rounds')
    parser.add_argument('--reload-every', type=int, default=0, help='Reload the panel every N rounds; zero disables')
    parser.add_argument('--device-scale', type=float, default=1, help='Device scale factor from 1 to 3')
    parser.add_argument('--reduced-motion', choices=['reduce', 'no-preference'], default='no-preference')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.rounds < 1 or not math.isfinite(args.minutes) or args.minutes < 0 or args.settle_every < 1 or args.reload_every < 0:
        parser.error('rounds and settle-every must be positive; minutes and reload-every must be nonnegative')
    if not math.isfinite(args.device_scale) or not 1 <= args.device_scale <= 3:
        parser.error('device-scale must be between 1 and 3')
    args.out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    started = time.monotonic()
    deadline = started + args.minutes * 60
    reports = []
    panel_times = []
    checkpoints = []
    page_errors = []
    settled_checks = 0
    panel_reloads = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(viewport={'width': 1200, 'height': 600},
                                    device_scale_factor=args.device_scale, reduced_motion=args.reduced_motion)
            page.on('pageerror', lambda error: page_errors.append(str(error)))
            metrics = page.context.new_cdp_session(page)
            metrics.send('Performance.enable')
            page.add_init_script(f'({INSTRUMENT})()')
            if args.control:
                source = args.control.read_text()
                page.route('**/jev-control.js', lambda route: route.fulfill(body=source,
                           content_type='application/javascript'))
            page.goto((ROOT / 'tests/browser/visual_harness.html').as_uri() + '?demo=composer')
            page.wait_for_function('document.title === "JEV_VISUAL_READY"')
            page.evaluate("""() => {
              const history = document.createElement('div');
              history.style.cssText = 'position:absolute;top:0;height:300px;overflow:auto';
              history.innerHTML = '<p>Synthetic history item with ordinary text.</p>'.repeat(5000);
              document.body.prepend(history);
            }""")
            panel = None
            snapshot = None
            snapshots = []
            if args.panel:
                snapshots = [json.loads(source.read_text()) for source in args.panel]
                panel = browser.new_page(viewport={'width': 1200, 'height': 600},
                                         device_scale_factor=args.device_scale, reduced_motion=args.reduced_motion)
                panel.on('pageerror', lambda error: page_errors.append(str(error)))
                panel_metrics = panel.context.new_cdp_session(panel)
                panel_metrics.send('Performance.enable')
                panel.goto((ROOT / 'tests/browser/jev_panel_harness.html').as_uri() + '?dense&capture')
                panel.wait_for_function('document.title === "JEV_LINE_PANEL_READY"')
            iteration = 0
            while iteration < args.rounds or time.monotonic() < deadline:
                iteration += 1
                reports.append(composer_round(page, rng, args.benchmark_only))
                if panel:
                    snapshot = snapshots[(iteration - 1) % len(snapshots)]
                    if args.reload_every and iteration % args.reload_every == 0:
                        panel.reload()
                        panel.wait_for_function('document.title === "JEV_LINE_PANEL_READY"')
                        panel_reloads += 1
                    panel_times.append(panel_round(panel, snapshot, iteration, reports[-1]['width']))
                    if iteration % args.settle_every == 0:
                        panel_settled(panel, snapshot)
                        settled_checks += 1
                assert not page_errors, page_errors
                page.wait_for_timeout(25)
                if iteration % 100 == 0:
                    measured = {item['name']: item['value'] for item in metrics.send('Performance.getMetrics')['metrics']}
                    checkpoint = {'rounds': iteration, 'elapsed_seconds': round(time.monotonic()-started),
                                  'heap_bytes': round(measured['JSHeapUsedSize']), 'last': reports[-1]}
                    if panel:
                        panel_measured = {item['name']: item['value'] for item in
                                         panel_metrics.send('Performance.getMetrics')['metrics']}
                        checkpoint['panel_heap_bytes'] = round(panel_measured['JSHeapUsedSize'])
                    checkpoints.append(checkpoint)
                    (args.out / 'checkpoint.json').write_text(json.dumps(checkpoint) + '\n')
                    print(json.dumps(checkpoint), flush=True)
            layout = page.evaluate('window.__jevLayout')
            times = sorted(layout['ms'])
            summary = {'seed': args.seed, 'rounds': iteration, 'elapsed_seconds': round(time.monotonic()-started, 3),
                       'device_scale': args.device_scale, 'reduced_motion': args.reduced_motion,
                       'panel_row_counts': sorted({len(value['rows']) for value in snapshots}),
                       'layout_calls': layout['calls'], 'visited_text_nodes': layout['textNodes'],
                       'layout_p50_ms': times[len(times)//2], 'layout_p95_ms': times[min(len(times)-1, int(len(times)*.95))],
                       'panel_renders': len(panel_times), 'panel_render_p95_ms':
                           sorted(panel_times)[min(len(panel_times)-1, int(len(panel_times)*.95))] if panel_times else None,
                       'settled_checks': settled_checks, 'panel_reloads': panel_reloads,
                       'page_errors': page_errors,
                       'max_checkpoint_heap_bytes': max((item['heap_bytes'] for item in checkpoints), default=0),
                       'max_panel_checkpoint_heap_bytes': max((item.get('panel_heap_bytes', 0)
                                                               for item in checkpoints), default=0)}
            (args.out / 'report.json').write_text(json.dumps({'summary': summary, 'cases': reports,
                                                            'checkpoints': checkpoints}, indent=2) + '\n')
            page.set_viewport_size({'width': 1200, 'height': 600})
            page.screenshot(path=str(args.out / 'composer.png'))
            if panel:
                panel.screenshot(path=str(args.out / 'panel.png'))
            print(json.dumps(summary), flush=True)
        except Exception:
            if 'page' in locals() and not page.is_closed():
                page.screenshot(path=str(args.out / 'failure.png'))
            raise
        finally:
            browser.close()


if __name__ == '__main__':
    main()
