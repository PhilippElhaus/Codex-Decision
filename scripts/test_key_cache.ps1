$ErrorActionPreference = 'Stop'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
if ([System.IO.Path]::GetPathRoot($tempRoot) -ieq 'D:\') { throw 'Temporary tests must stay off D:.' }
$trial = Join-Path $tempRoot ('codex-jev-credential-test-' + [guid]::NewGuid().ToString('N'))
$installer = Join-Path $PSScriptRoot 'install_key_cache.ps1'
$expected = 'synthetic-jev-key-for-tests'
try {
    New-Item -ItemType Directory -Path $trial | Out-Null
    $helper = Join-Path $trial 'fake-vaultwarden.ps1'
    @'
param([string]$Action, [string]$CollectionName, [string]$Name, [string]$OutputPath)
if ($Action -ne 'materialize' -or $CollectionName -ne 'demo' -or $Name -ne 'jev') {
    throw 'Unexpected test credential request.'
}
[System.IO.File]::WriteAllText($OutputPath, 'synthetic-jev-key-for-tests')
'@ | Set-Content -LiteralPath $helper -Encoding utf8
    $state = Join-Path $trial 'state'
    & $installer -StateDirectory $state -VaultwardenHelper $helper -CollectionName demo -ItemName jev | Out-Null
    $source = Get-Content -LiteralPath (Join-Path $state 'credential-source.json') -Raw | ConvertFrom-Json
    if ($source.helper -ne $helper -or $source.item -ne 'jev') { throw 'Credential source was not saved.' }
    if ((Get-Content -LiteralPath (Join-Path $state 'credential-source.json') -Raw).Contains($expected)) {
        throw 'Credential source contains the key.'
    }
    $protected = [System.IO.File]::ReadAllBytes((Join-Path $state 'key.dpapi'))
    $clear = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if ([System.Text.Encoding]::UTF8.GetString($clear) -ne $expected) { throw 'Protected cache did not round-trip.' }
    } finally {
        [System.Array]::Clear($clear, 0, $clear.Length)
    }
    & (Join-Path $state 'refresh_key_cache.ps1') -StateDirectory $state | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $state 'key.dpapi') -PathType Leaf)) {
        throw 'Credential refresh removed the protected cache.'
    }
    $migrated = Join-Path $trial 'migrated'
    & (Join-Path $PSScriptRoot 'migrate_legacy_key.ps1') -LegacyDirectory $state -StateDirectory $migrated | Out-Null
    $copied = [System.IO.File]::ReadAllBytes((Join-Path $migrated 'key.dpapi'))
    $revealed = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $copied, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        if ([System.Text.Encoding]::UTF8.GetString($revealed) -ne $expected) {
            throw 'Legacy credential migration did not preserve the key.'
        }
    } finally {
        [System.Array]::Clear($revealed, 0, $revealed.Length)
    }
    $unconfigured = Join-Path $trial 'unconfigured'
    try {
        & $installer -StateDirectory $unconfigured | Out-Null
        throw 'Unconfigured refresh unexpectedly succeeded.'
    } catch {
        if ($_.Exception.Message -notmatch 'JEV_REFRESH_NOT_CONFIGURED') { throw }
    }
    Write-Output 'Protected key setup, automatic refresh, and unconfigured-source checks passed.'
} finally {
    if (Test-Path -LiteralPath $trial) {
        $item = Get-Item -LiteralPath $trial -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-ChildItem -LiteralPath $trial -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)) {
            throw 'Credential test directory contains a link; inspect before cleanup.'
        }
        Remove-Item -LiteralPath $trial -Recurse -Force
    }
}
