[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Write-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][bool]$Available,
    [string]$Detail = ''
  )

  $status = if ($Available) { 'OK' } else { 'MISSING' }
  if ($Detail) {
    Write-Output ('[{0}] {1}: {2}' -f $status, $Name, $Detail)
  } else {
    Write-Output ('[{0}] {1}' -f $status, $Name)
  }
}

function Get-CommandVersion {
  param(
    [Parameter(Mandatory = $true)][string]$CommandName,
    [string[]]$Arguments = @('--version')
  )

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if ($null -eq $command) { return $null }

  try {
    $version = & $command.Source @Arguments 2>$null | Select-Object -First 1
    return [string]$version
  } catch {
    return 'found, version unavailable'
  }
}

function Write-FileHashCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Check -Name $Name -Available $false -Detail 'not present (Mock development remains available)'
    return
  }

  $item = Get-Item -LiteralPath $Path
  $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
  Write-Check -Name $Name -Available $true -Detail ('{0}; {1:N2} MB; SHA256={2}' -f $item.FullName, ($item.Length / 1MB), $hash.Hash)
}

Write-Output 'Minutes Transcription App - read-only development environment check'
Write-Output ('Repository: {0}' -f $repoRoot)
Write-Output 'No files, settings, ports, or processes are changed by this script.'
Write-Output ''

$nodeVersion = Get-CommandVersion -CommandName 'node.exe'
Write-Check -Name 'Node.js' -Available ($null -ne $nodeVersion) -Detail $nodeVersion

$npmVersion = Get-CommandVersion -CommandName 'npm.cmd'
Write-Check -Name 'npm.cmd' -Available ($null -ne $npmVersion) -Detail $npmVersion

$pnpmVersion = Get-CommandVersion -CommandName 'pnpm.cmd'
if ($null -eq $pnpmVersion) {
  $pnpmVersion = Get-CommandVersion -CommandName 'pnpm'
}
Write-Check -Name 'pnpm' -Available ($null -ne $pnpmVersion) -Detail $(if ($pnpmVersion) { $pnpmVersion } else { 'not on the current PATH' })
if ($null -eq $pnpmVersion) {
  $corepack = Get-Command 'corepack.cmd' -ErrorAction SilentlyContinue
  Write-Check -Name 'corepack.cmd alternative' -Available ($null -ne $corepack) -Detail $(if ($corepack) { 'available; activation is not performed by this script' } else { 'not available' })
}

$gitVersion = Get-CommandVersion -CommandName 'git.exe'
Write-Check -Name 'Git' -Available ($null -ne $gitVersion) -Detail $(if ($gitVersion) { $gitVersion } else { 'not installed or not on PATH; do not install automatically' })

Write-Output ''
Write-Check -Name 'package.json' -Available (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json') -PathType Leaf)
Write-Check -Name 'pnpm-lock.yaml' -Available (Test-Path -LiteralPath (Join-Path $repoRoot 'pnpm-lock.yaml') -PathType Leaf)
Write-Check -Name 'node_modules' -Available (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules') -PathType Container) -Detail 'if missing, run pnpm.cmd install --frozen-lockfile'
Write-Check -Name '.env' -Available (Test-Path -LiteralPath (Join-Path $repoRoot '.env') -PathType Leaf) -Detail 'existence only; contents are intentionally not displayed'
Write-Check -Name '.env.example' -Available (Test-Path -LiteralPath (Join-Path $repoRoot '.env.example') -PathType Leaf)

foreach ($directory in @('src', 'server\src', 'server\test', 'shared', 'docs', 'scripts')) {
  Write-Check -Name ('directory ' + $directory) -Available (Test-Path -LiteralPath (Join-Path $repoRoot $directory) -PathType Container)
}

Write-Output ''
$modelPath = Join-Path $repoRoot 'server\data\local-stt\models\ggml-small-q5_1.bin'
Write-FileHashCheck -Name 'Local Whisper small model' -Path $modelPath

$binaryRoot = Join-Path $repoRoot 'server\data\local-stt\bin'
$whisperCli = $null
if (Test-Path -LiteralPath $binaryRoot -PathType Container) {
  $whisperCli = Get-ChildItem -LiteralPath $binaryRoot -Filter 'whisper-cli.exe' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1
}
if ($null -eq $whisperCli) {
  Write-Check -Name 'whisper-cli.exe' -Available $false -Detail 'not present (Mock development remains available)'
} else {
  Write-FileHashCheck -Name 'whisper-cli.exe' -Path $whisperCli.FullName
}

Write-Output ''
foreach ($port in @(5173, 8787)) {
  $listeners = @()
  if (Get-Command 'Get-NetTCPConnection' -ErrorAction SilentlyContinue) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  }

  if ($listeners.Count -eq 0) {
    Write-Output ('[FREE] port {0}: no listening process found' -f $port)
  } else {
    $processIds = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ','
    Write-Output ('[IN USE] port {0}: listening process ID(s) {1}; verify ownership before stopping anything' -f $port, $processIds)
  }
}

Write-Output ''
Write-Output 'If the model or executable is missing, use Browser/Mock/WebSocket Mock development. Do not download or install anything automatically.'
Write-Output 'Compare SHA-256 values with hashes supplied by the team through an independent trusted channel.'
