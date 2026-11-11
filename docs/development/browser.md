# Browser checks and screenshots

Run the real composer, settings, and panel scripts with synthetic fixtures:

```bash
python vscode-control/scripts/browser_smoke.py --browser chromium
python vscode-control/scripts/browser_quality.py --rounds 50 --seed 7 \
  --fallback-every 5 --out .local/quality/browser-review
```

Linux CI uses Playwright and Chromium. The default native browser path supports Edge. [Browser fixtures](../../tests/browser) check widths, internal thread navigation, missing and late replies, connection states, settings, cumulative updates, totals, raw capture, reloads, and toolbar fallback.

`browser_quality.py` rotates seeded sizes and message order. Use `--panel <snapshot>` for a fixture, `--resident-panels` to clone messages inside the page, `--reload-every 500` for reload endurance, and `--fallback-every 10` for toolbar recovery. Compare timing between equivalent transports. Sending complete snapshots through the debugger includes driver overhead.

CI adds a short resident-panel run with a reviewed historical fixture and a current protected-row fixture. Historical readers remain tested because existing user records can contain those formats.

Generate documentation images with:

```bash
python vscode-control/scripts/capture_docs.py
```

Capture uses [visual_harness.html](../../tests/browser/visual_harness.html) and the real webview code. Inspect images against that code before publishing. Use synthetic data and empty key fields. Never capture private chats, real keys, or installed raw records. Images live in `docs/images/`.

Native Windows checks remain separate. Linux Chromium cannot validate WSL UNC permissions, native installation, or VS Code's extension host. See [test commands](../../tests/README.md) and [package validation](builds.md).
