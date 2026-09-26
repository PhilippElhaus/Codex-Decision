"""Locate Edge and an off-workspace Windows temp root for visual tests."""

from pathlib import Path
import subprocess


def windows_path(path: Path) -> str:
    return subprocess.check_output(['wslpath', '-w', str(path)], text=True).strip()


def browser_environment() -> tuple[Path, Path]:
    lookup = r'''
$ErrorActionPreference = 'Stop'
$candidates = @()
foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if ($root) {
        $candidates += (Join-Path $root 'Microsoft\Edge\Application\msedge.exe')
    }
}
$edge = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found.' }
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if ([System.IO.Path]::GetPathRoot($tempRoot) -ieq 'D:\') { throw 'Windows temp root must stay off D:.' }
Write-Output $edge
Write-Output $tempRoot
'''
    rows = subprocess.check_output(['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', lookup], text=True).splitlines()
    if len(rows) != 2:
        raise RuntimeError('Could not locate Edge and the Windows temp root')
    edge, temporary = (Path(subprocess.check_output(['wslpath', '-u', row], text=True).strip()) for row in rows)
    if not edge.is_file() or not temporary.is_dir():
        raise RuntimeError('Edge or the Windows temp root is unavailable from WSL')
    return edge, temporary


def remove_profile(profile: Path, prefix: str) -> None:
    cleanup = r'''
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$target = [System.IO.Path]::GetFullPath($env:JEV_BROWSER_PROFILE).TrimEnd('\')
if ([System.IO.Path]::GetPathRoot($root) -ieq 'D:\' -or
    -not $target.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
    -not ([System.IO.Path]::GetFileName($target)).StartsWith($env:JEV_BROWSER_PREFIX)) {
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
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    cleanup = cleanup.replace('$env:JEV_BROWSER_PROFILE', quote(windows_path(profile)))
    cleanup = cleanup.replace('$env:JEV_BROWSER_PREFIX', quote(prefix))
    result = subprocess.run(['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', cleanup],
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError('Edge profile cleanup failed: ' + result.stderr.strip())
