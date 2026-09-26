param(
    [string]$LegacyDirectory = (Join-Path $env:LOCALAPPDATA 'Codex\jev-output-pilot'),
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Codex\codex-jev')
)

$ErrorActionPreference = 'Stop'
$old = [System.IO.Path]::GetFullPath($LegacyDirectory)
$new = [System.IO.Path]::GetFullPath($StateDirectory)
if ([System.IO.Path]::GetPathRoot($old) -ieq 'D:\' -or
    [System.IO.Path]::GetPathRoot($new) -ieq 'D:\' -or $old -ieq $new) {
    throw 'Jev credential migration requires distinct protected paths off D:.'
}
$sourcePath = Join-Path $old 'credential-source.json'
foreach ($candidate in @($old, $sourcePath)) {
    if (-not (Test-Path -LiteralPath $candidate)) { throw 'Legacy Vaultwarden source was not found.' }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Legacy credential source contains a link.'
    }
}
$source = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
if ($source.mode -ne 'vaultwarden') {
    throw 'Legacy key has no Vaultwarden source; use install_key_cache.ps1 -PromptForKey.'
}
& (Join-Path $PSScriptRoot 'install_key_cache.ps1') -StateDirectory $new `
    -VaultwardenHelper ([string]$source.helper) `
    -CollectionName ([string]$source.collection) -ItemName ([string]$source.item)
if ($LASTEXITCODE -ne 0) { throw 'Codex Jev credential installation failed.' }
