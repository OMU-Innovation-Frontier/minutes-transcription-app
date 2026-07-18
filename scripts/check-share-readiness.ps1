[CmdletBinding()]
param(
  [ValidateRange(1, 10240)]
  [int]$LargeFileThresholdMB = 10
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gitignorePath = Join-Path $repoRoot '.gitignore'

function Get-RelativePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  return $fullPath.Substring($repoRoot.Length).TrimStart('\', '/')
}

function Test-UnderDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$RelativeDirectory
  )

  $directory = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $RelativeDirectory)).TrimEnd('\', '/')
  $candidate = [System.IO.Path]::GetFullPath($Path)
  return $candidate.Equals($directory, [System.StringComparison]::OrdinalIgnoreCase) -or
    $candidate.StartsWith($directory + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

Write-Output 'Minutes Transcription App - read-only share readiness review'
Write-Output ('Repository: {0}' -f $repoRoot)
Write-Output 'This script lists candidates only. It never deletes, moves, edits, uploads, commits, or pushes files.'
Write-Output 'Results can include false positives and cannot guarantee complete secret detection.'
Write-Output ''

$requiredIgnoreRules = @(
  'node_modules/',
  'dist/',
  'coverage/',
  '.env',
  '.env.*',
  '!.env.example',
  'server/data/',
  '*.wav',
  '*.mp3',
  '*.m4a',
  '*.webm',
  '*.flac',
  '*.log',
  'logs/',
  '*-backup-*/',
  'backup/',
  'backups/',
  '.DS_Store',
  'Thumbs.db',
  '.vscode/',
  '.idea/'
)

Write-Output '[.gitignore required rules]'
$ignoreLines = @()
if (Test-Path -LiteralPath $gitignorePath -PathType Leaf) {
  $ignoreLines = @(Get-Content -LiteralPath $gitignorePath -Encoding UTF8 | ForEach-Object { $_.Trim() })
}
foreach ($rule in $requiredIgnoreRules) {
  $present = $ignoreLines -contains $rule
  Write-Output ('[{0}] {1}' -f $(if ($present) { 'OK' } else { 'MISSING' }), $rule)
}

Write-Output ''
Write-Output '[High-risk or generated directories]'
foreach ($relativeDirectory in @('node_modules', 'dist', 'server\dist', 'coverage', 'server\data', '.vscode', '.idea')) {
  $path = Join-Path $repoRoot $relativeDirectory
  if (Test-Path -LiteralPath $path -PathType Container) {
    $fileCount = @(Get-ChildItem -LiteralPath $path -File -Recurse -Force -ErrorAction SilentlyContinue).Count
    Write-Output ('CANDIDATE directory: {0} ({1} files); review ignore rule before sharing' -f $relativeDirectory, $fileCount)
  }
}

$allFiles = @(Get-ChildItem -LiteralPath $repoRoot -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
  -not (Test-UnderDirectory -Path $_.FullName -RelativeDirectory 'node_modules')
})
$thresholdBytes = $LargeFileThresholdMB * 1MB
$candidateRows = New-Object System.Collections.Generic.List[object]

foreach ($file in $allFiles) {
  $relative = Get-RelativePath -Path $file.FullName
  $lowerName = $file.Name.ToLowerInvariant()
  $extension = $file.Extension.ToLowerInvariant()
  $category = $null
  $ignoreRule = $null

  if ($file.Name -eq '.env' -or ($file.Name -like '.env.*' -and $file.Name -ne '.env.example')) {
    $category = 'local environment / possible credential'
    $ignoreRule = '.env or .env.*'
  } elseif ($extension -in @('.wav', '.mp3', '.m4a', '.webm', '.flac')) {
    $category = 'audio recording'
    $ignoreRule = '*' + $extension
  } elseif ($lowerName -eq 'whisper-cli.exe' -or $lowerName -like 'ggml-*.bin') {
    $category = 'Whisper executable or model'
    $ignoreRule = 'server/data/, whisper-cli.exe, or ggml-*.bin'
  } elseif ($extension -in @('.exe', '.dll', '.zip') -and (Test-UnderDirectory -Path $file.FullName -RelativeDirectory 'server\data')) {
    $category = 'downloaded local runtime artifact'
    $ignoreRule = 'server/data/'
  } elseif ($extension -eq '.log' -or $relative -match '(^|[\\/])logs?([\\/]|$)') {
    $category = 'log'
    $ignoreRule = '*.log or logs/'
  } elseif ($relative -match '(^|[\\/])server[\\/]data([\\/]|$)') {
    $category = 'runtime, debug, evaluation, metadata, or comparison data'
    $ignoreRule = 'server/data/'
  } elseif ($lowerName -match '(metadata|comparison|indexeddb)' -and $extension -in @('.json', '.jsonl')) {
    $category = 'metadata, comparison, or IndexedDB export candidate'
    $ignoreRule = 'specific generated-data rule; manual review required'
  } elseif ($relative -match '(?i)(^|[\\/])(backup|backups)([\\/]|$)|-backup-|\.(bak|backup)$') {
    $category = 'backup'
    $ignoreRule = 'backup rules'
  } elseif ($lowerName -match '(?i)(api.?key|credential|password|passwd|secret|access.?token)') {
    $category = 'sensitive-looking filename'
    $ignoreRule = 'manual review required'
  } elseif ($file.Length -ge $thresholdBytes) {
    $category = ('large file >= {0} MB' -f $LargeFileThresholdMB)
    $ignoreRule = 'manual review required'
  }

  if ($null -ne $category) {
    $candidateRows.Add([PSCustomObject]@{
      Path = $relative
      Category = $category
      SizeMB = [math]::Round($file.Length / 1MB, 2)
      ExpectedProtection = $ignoreRule
    })
  }
}

Write-Output ''
Write-Output '[Candidate files - names and sizes only]'
if ($candidateRows.Count -eq 0) {
  Write-Output 'No filename/size candidates found.'
} else {
  $candidateRows | Sort-Object Category, Path | Format-Table -AutoSize | Out-String -Width 240 | Write-Output
}

Write-Output '[Conservative content signals in shareable text files - filenames only]'
$contentSignals = @(
  [PSCustomObject]@{ Name = 'known token/private-key format'; Pattern = '(sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)' },
  [PSCustomObject]@{ Name = 'non-empty generic credential assignment'; Pattern = '(?i)(api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|credential)\s*[:=]\s*["''][^"'']{8,}["'']' },
  [PSCustomObject]@{ Name = 'email-shaped text'; Pattern = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' },
  [PSCustomObject]@{ Name = 'user-specific absolute path'; Pattern = '(?i)([A-Z]:[\\/]Users[\\/][^\\/\s]+|/Users/[^/\s]+|/home/[^/\s]+)' }
)
$textExtensions = @('.ts', '.js', '.json', '.jsonl', '.md', '.yml', '.yaml', '.html', '.css', '.env', '.example', '.ps1', '.txt')
$signalCount = 0
foreach ($file in $allFiles) {
  if ($file.FullName -eq $PSCommandPath) { continue }
  if ($file.Length -gt 2MB) { continue }
  if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
  if (Test-UnderDirectory -Path $file.FullName -RelativeDirectory 'dist') { continue }
  if (Test-UnderDirectory -Path $file.FullName -RelativeDirectory 'server\dist') { continue }
  if (Test-UnderDirectory -Path $file.FullName -RelativeDirectory 'server\data') { continue }

  $content = $null
  try { $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 } catch { continue }
  foreach ($signal in $contentSignals) {
    if ($content -match $signal.Pattern) {
      Write-Output ('REVIEW: {0} [{1}]' -f (Get-RelativePath -Path $file.FullName), $signal.Name)
      $signalCount++
    }
  }
}
if ($signalCount -eq 0) { Write-Output 'No configured content signals found.' }

Write-Output ''
$git = Get-Command 'git.exe' -ErrorAction SilentlyContinue
if ($null -eq $git) {
  Write-Output '[Git] unavailable; tracked-file and git check-ignore verification was not performed.'
} else {
  $insideWorkTree = & $git.Source -C $repoRoot rev-parse --is-inside-work-tree 2>$null
  if ($LASTEXITCODE -eq 0 -and $insideWorkTree -eq 'true') {
    $tracked = @(& $git.Source -C $repoRoot ls-files)
    Write-Output ('[Git] tracked files: {0}' -f $tracked.Count)
    $trackedRisk = @($tracked | Where-Object { $_ -match '(^|/)(server/data|node_modules|dist|coverage)/|(^|/)\.env($|\.)|\.(wav|mp3|m4a|webm|flac|log|exe|bin)$' })
    if ($trackedRisk.Count -eq 0) {
      Write-Output '[Git] no configured high-risk tracked paths found.'
    } else {
      Write-Output '[Git] REVIEW tracked high-risk path candidates:'
      $trackedRisk | ForEach-Object { Write-Output ('  ' + $_) }
    }
  } else {
    Write-Output '[Git] available, but this directory is not an initialized work tree.'
  }
}

Write-Output ''
Write-Output 'Manual review is required before the first commit and before every push.'
Write-Output 'Do not paste candidate file contents into issues, pull requests, chats, or audit reports.'
