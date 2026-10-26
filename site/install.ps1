# Rendezvous installer for Windows (PowerShell 5.1 and 7+).
#
#   irm https://rendezvous.nesher.co/install.ps1 | iex
#
# Clones (or updates) the reference implementation into ~\.rendezvous\src,
# builds it with npm, and writes `rdv` and `rdv-mcp` shims into npm's global
# prefix (user-writable, already on PATH with a standard Node install). No
# administrator rights needed. Safe to run again: it pulls and rebuilds.
#
# Overrides (environment variables):
#   RDV_REPO     git URL or local path to clone   (default: https://github.com/omernesh/rendezvous)
#   RDV_DIR      where the clone lives            (default: ~\.rendezvous\src)
#   RDV_BIN_DIR  where the shims go               (default: `npm prefix -g`)
#
# Note: rdv keeps profiles in ~\.rendezvous\<profile>, so don't name a profile "src".

& {
  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $Marker = 'rendezvous-installer-shim'

  function Fail([string]$msg) {
    Write-Host "rendezvous install: error: $msg" -ForegroundColor Red
    throw "rendezvous install failed: $msg"
  }
  function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

  # Run a native command and stop on a non-zero exit code
  # ($ErrorActionPreference does not cover native commands in PowerShell 5.1).
  function Run([string]$exe, [string[]]$argv) {
    $real = Tool $exe
    if ($real) { $exe = $real }
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { Fail "'$exe $($argv -join ' ')' exited with code $LASTEXITCODE" }
  }
  # Resolve a tool to its real executable. Windows PowerShell 5.1 under a Restricted execution policy refuses
  # npm.ps1 (a bare `npm` finds it first, with a misleading message), so ask for npm.cmd / git.exe by name.
  function Tool([string]$name) {
    $file = switch ($name) { 'npm' { 'npm.cmd' } 'git' { 'git.exe' } 'node' { 'node.exe' } default { $name } }
    $c = Get-Command $file -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($c) { return $c.Source }
    return $null
  }
  function Need([string]$name) {
    if (Tool $name) { return }
    if ($name -eq 'git') {
      Fail 'git is required but was not found on PATH. Install it with: winget install --id Git.Git -e (or from https://git-scm.com/download/win), open a new terminal, then run this installer again'
    }
    if ($name -eq 'node' -or $name -eq 'npm') {
      Fail "$name is required but was not found on PATH. Get Node.js 20 or newer from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)"
    }
    Fail "$name is required but was not found on PATH"
  }
  # A repo URL in one spelling: no trailing slash or ".git", lowercase scheme and host (the path keeps its case).
  function NormRepo([string]$u) {
    $u = $u.Trim()
    while ($u -match '(/|\.git)$') { $u = $u -replace '(/|\.git)$', '' }
    if ($u -match '^([A-Za-z][A-Za-z0-9+.-]*)://([^/]*)(.*)$') { $u = $Matches[1].ToLower() + '://' + $Matches[2].ToLower() + $Matches[3] }
    return $u
  }

  # --- prerequisites -------------------------------------------------------
  Need 'git'; Need 'node'; Need 'npm'
  $Node = Tool 'node'; $Npm = Tool 'npm'; $Git = Tool 'git'
  $nodeVersion = (& $Node -p 'process.versions.node')
  if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Fail 'could not read the Node.js version' }
  $nodeMajor = [int]($nodeVersion.Trim().Split('.')[0])
  if ($nodeMajor -lt 20) { Fail "Node.js 20 or newer is required (found v$nodeVersion). Get it from https://nodejs.org" }

  $Repo = if ($env:RDV_REPO) { $env:RDV_REPO } else { 'https://github.com/omernesh/rendezvous' }
  $Dir  = if ($env:RDV_DIR)  { $env:RDV_DIR }  else { Join-Path $HOME '.rendezvous\src' }
  if ($env:RDV_BIN_DIR) {
    $BinDir = $env:RDV_BIN_DIR
  } else {
    $BinDir = (& $Npm prefix -g)
    if ($LASTEXITCODE -ne 0 -or -not $BinDir) { Fail "could not read npm's global prefix (npm prefix -g)" }
    $BinDir = $BinDir.Trim()
  }
  Step "node v$nodeVersion, $(& $Git --version), npm $(& $Npm --version)"

  # --- clone or update ------------------------------------------------------
  if (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
    $origin = (& $Git -C $Dir remote get-url origin)
    if ($LASTEXITCODE -ne 0) { Fail "$Dir is a git clone without an 'origin' remote" }
    if ((NormRepo "$origin") -ne (NormRepo $Repo) -and $origin.Trim() -ne $Repo) {
      Fail "$Dir is a clone of '$($origin.Trim())', not '$Repo'. Move it away or set RDV_DIR"
    }
    Step "Updating $Dir"
    Run 'git' @('-C', $Dir, 'pull', '--ff-only')
  } elseif (Test-Path -LiteralPath $Dir) {
    Fail "$Dir exists but is not a git clone. Move it away or set RDV_DIR"
  } else {
    Step "Cloning $Repo into $Dir"
    $parent = Split-Path -Parent $Dir
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Run 'git' @('clone', $Repo, $Dir)
  }

  # --- build ----------------------------------------------------------------
  $Impl = Join-Path $Dir 'impl'
  if (-not (Test-Path -LiteralPath (Join-Path $Impl 'package.json'))) { Fail "$Impl\package.json not found; is $Repo the Rendezvous repo?" }
  Push-Location $Impl
  try {
    Step 'npm ci'
    Run 'npm' @('ci', '--no-audit', '--no-fund')
    Step 'npm run build'
    Run 'npm' @('run', 'build')
  } finally {
    Pop-Location
  }

  $Targets = [ordered]@{
    'rdv'     = Join-Path $Impl 'packages\cli\dist\src\bin.js'
    'rdv-mcp' = Join-Path $Impl 'packages\mcp\dist\src\bin.js'
  }
  foreach ($t in $Targets.Values) {
    if (-not (Test-Path -LiteralPath $t)) { Fail "build finished but $t is missing" }
  }

  # --- shims ----------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
  foreach ($name in $Targets.Keys) {
    $js = $Targets[$name]
    $shims = @{
      "$name.cmd" = "@echo off`r`nrem $Marker`r`nnode `"$js`" %*`r`n"
      # extensionless sh shim, for Git Bash / MSYS shells
      "$name"     = "#!/bin/sh`n# $Marker`nexec node `"$($js -replace '\\','/')`" `"`$@`"`n"
    }
    foreach ($file in $shims.Keys) {
      $path = Join-Path $BinDir $file
      if ((Test-Path -LiteralPath $path) -and -not (Select-String -LiteralPath $path -SimpleMatch $Marker -Quiet)) {
        Fail "$path already exists and was not written by this installer. Remove it or set RDV_BIN_DIR"
      }
      [System.IO.File]::WriteAllText($path, $shims[$file], (New-Object System.Text.UTF8Encoding($false)))
    }
  }
  Step "Wrote rdv and rdv-mcp shims to $BinDir"

  # Smoke test through the shim, not the build output.
  $out = (& (Join-Path $BinDir 'rdv.cmd') --help 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { Fail "rdv --help failed after install:`n$out" }

  # Check the PERSISTED User + Machine PATH, not this process's $env:Path: the installer may run from a shell
  # that already has the folder (an IDE or agent session) while a fresh terminal does not (issue #66).
  function NormDir([string]$d) {
    $d = [Environment]::ExpandEnvironmentVariables($d.Trim().Trim('"'))
    return $d.TrimEnd('\', '/')
  }
  $want = NormDir $BinDir
  $onPath = $false
  foreach ($scope in 'User', 'Machine') {
    $persisted = [Environment]::GetEnvironmentVariable('Path', $scope)
    if (-not $persisted) { continue }
    foreach ($p in ($persisted -split ';')) {
      if ($p.Trim() -and ((NormDir $p) -ieq $want)) { $onPath = $true }
    }
  }

  Write-Host ''
  Write-Host 'Rendezvous is installed.' -ForegroundColor Green
  if (-not $onPath) {
    Write-Host ''
    Write-Host "WARNING: $BinDir is not on your saved PATH, so 'rdv' won't be found in new terminals." -ForegroundColor Yellow
    Write-Host "Add it for your user, then open a new terminal:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + `";$BinDir`", 'User')"
    Write-Host "Until then, call it by full path:" -ForegroundColor Yellow
    Write-Host "  & `"$(Join-Path $BinDir 'rdv.cmd')`" --help"
  }
  Write-Host @"

Next steps:
  rdv init --profile omer --email omer@example.com --public-pointer   # default public relays; --relay wss://... for your own
  rdv card publish --profile omer    # make the address findable (--public-pointer above is what allows it)
  rdv whoami --profile omer
  rdv listen --profile omer

Or let your agent do the rest. In Claude Code's chat, type
  /plugin marketplace add omernesh/rendezvous
  /plugin install rendezvous@rendezvous
  /reload-plugins
then type /rdv-onboarding. (Without the plugin:
  claude mcp add rendezvous -- node "$($Targets['rdv-mcp'])" --profile omer)

Other agents (Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Windsurf,
Grok Build, OpenClaw, Hermes, Muse Code): https://github.com/omernesh/rendezvous/blob/main/docs/agents.md

Update later by running the installer again. Docs: https://rendezvous.nesher.co
"@
}
