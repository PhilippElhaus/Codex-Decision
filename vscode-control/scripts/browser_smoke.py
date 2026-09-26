"""Run the real composer script in headless Edge with a mock VS Code bridge."""

from pathlib import Path
import json
import re
import subprocess
import tempfile
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
EDGE = Path('/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
TEMP = Path('/mnt/r/Temp/User')


def windows_path(path: Path) -> str:
    return subprocess.check_output(['wslpath', '-w', str(path)], text=True).strip()


def main() -> None:
    if not EDGE.is_file() or not TEMP.is_dir():
        raise RuntimeError('Windows Edge or the approved Windows temp root is missing')
    profile = Path(tempfile.mkdtemp(prefix='jev-edge-test-', dir=TEMP))
    try:
        target = windows_path(ROOT / 'tests/browser_harness.html').replace('\\', '/')
        address = 'file:///' + quote(target, safe='/:')
        reports = []
        for width in (720, 1200):
            result = subprocess.run([
                str(EDGE), '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--disable-extensions',
                '--virtual-time-budget=3000', f'--window-size={width},600',
                f'--user-data-dir={windows_path(profile / f"viewport-{width}")}',
                '--dump-dom', address,
            ], capture_output=True, text=True, timeout=30, check=False)
            match = re.search(r'<pre class="results" id="results">([^<]+)</pre>', result.stdout)
            if result.returncode != 0 or not match:
                raise RuntimeError(f'Edge browser harness failed at {width}px: exit={result.returncode}, result missing')
            outcome = json.loads(match.group(1).replace('&quot;', '"'))
            if not outcome.get('ok'):
                raise AssertionError({'viewport': width, **outcome})
            reports.append({'viewport': width, **outcome})
        print(json.dumps(reports))
    finally:
        cleanup = r'''
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$target = [System.IO.Path]::GetFullPath($env:JEV_BROWSER_PROFILE).TrimEnd('\')
if ([System.IO.Path]::GetPathRoot($root) -ieq 'D:\' -or
    -not $target.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    -not ([System.IO.Path]::GetFileName($target)).StartsWith('jev-edge-test-')) {
    throw 'Unexpected Edge test profile path.'
}
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        (Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) {
        throw 'Edge test profile contains a link.'
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}
'''
        quoted_profile = "'" + windows_path(profile).replace("'", "''") + "'"
        cleanup = cleanup.replace('$env:JEV_BROWSER_PROFILE', quoted_profile)
        result = subprocess.run(['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', cleanup],
                                capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError('Edge test profile cleanup failed: ' + result.stderr.strip())


if __name__ == '__main__':
    main()
