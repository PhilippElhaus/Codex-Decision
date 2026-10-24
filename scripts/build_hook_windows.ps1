[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
if (-not $IsWindows -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Native hook builds require Windows x86_64 and PowerShell 7.'
}
$taskTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else {
    Join-Path $env:LOCALAPPDATA 'Codex\build\codex-decision'
}
if ([System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($taskTarget)) -eq 'D:\') {
    throw 'Cargo build output must remain outside D:.'
}
& cargo build --locked --manifest-path (Join-Path $repository 'Cargo.toml') `
    --target x86_64-pc-windows-msvc --release -p codex-decision --target-dir $taskTarget
if ($LASTEXITCODE) { throw 'Native Rust build failed.' }
$release = Join-Path $taskTarget 'x86_64-pc-windows-msvc\release'
& (Join-Path $release 'decisionctl.exe') check-release-versions --root $repository
if ($LASTEXITCODE) { throw 'Release versions differ.' }
$destination = Join-Path $repository 'hooks\bin\windows-x86_64'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($name in @('decision-hook', 'decisionctl')) {
    $binary = Join-Path $release ($name + '.exe')
    $actual = & $binary --version
    $version = (Get-Content -LiteralPath (Join-Path $repository 'vscode-control\package.json') -Raw | ConvertFrom-Json).codexDecisionHookVersion
    if ($LASTEXITCODE -or $actual -ne "$name $version") { throw 'Native binary version differs.' }
    Copy-Item -LiteralPath $binary -Destination (Join-Path $destination ($name + '.exe'))
}
