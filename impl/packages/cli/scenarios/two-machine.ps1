# Two-machine contact scenario (PLAN 4.5, run 2). PowerShell 7+, run on the Windows side.
#   John  = remote host (default relay-host), `rdv listen --auto-grant friend`
#   Omer  = this machine
# Both talk to the same relay. Exits 0 on PASS, 1 on FAIL. Cleans up its own processes and temp dirs.
#   pwsh two-machine.ps1 [-Relay ws://<relay-host>:7777] [-Remote user@<relay-host>] [-RemoteRepo '~/src/rendezvous-test']
param(
  [string]$Relay = 'ws://<relay-host>:7777',
  [string]$Remote = 'user@<relay-host>',
  [string]$RemoteRepo = '~/src/rendezvous-test',
  [int]$TimeoutSec = 30
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path (Split-Path -Parent $here) 'dist/src/bin.js'   # scenarios/ -> packages/cli/dist
$tag = -join ((1..8) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
$johnEmail = "john+$tag@doe.com"
$work = Join-Path ([IO.Path]::GetTempPath()) "rdv-2m-$tag"
$omerHome = Join-Path $work 'omer'
$johnHome = "/tmp/rdv-2m-$tag"
$rdvRemote = "node $RemoteRepo/impl/packages/cli/dist/src/bin.js"
New-Item -ItemType Directory -Force $work | Out-Null

function Remote([string]$script) {
  # base64 keeps CRLF and quoting out of the way
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script.Replace("`r", '') + "`n"))
  ssh -o BatchMode=yes $Remote "echo $b64 | base64 -d | bash"
  if ($LASTEXITCODE) { throw "remote failed: $script" }
}
function Rdv { node $bin @args --home $omerHome --json; if ($LASTEXITCODE) { throw "rdv $args failed" } }
function WaitFor([string]$what, [scriptblock]$test) {
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) { $r = try { & $test } catch { $null }; if ($r) { return $r }; Start-Sleep -Milliseconds 300 }
  throw "timeout waiting for: $what"
}

$omerListen = $null
try {
  Write-Host "- init (relay $Relay, john $johnEmail on $Remote)"
  Remote "$rdvRemote init --profile john --email $johnEmail --relay $Relay --home $johnHome --json >/dev/null"
  Rdv init --profile omer --email "omer+$tag@example.com" --relay $Relay | Out-Null
  $johnId = ((Remote "$rdvRemote whoami --home $johnHome --json") | ConvertFrom-Json).id
  $omerId = ((Rdv whoami) | ConvertFrom-Json).id

  Write-Host '- start listeners (john on remote, omer here)'
  Remote "mkdir -p $johnHome; cd /tmp; setsid nohup $rdvRemote listen --auto-grant friend --home $johnHome --json > $johnHome/listen.log 2>&1 < /dev/null &
echo `$! > $johnHome/listen.pid; exit 0"
  $omerLog = Join-Path $work 'omer-listen.log'
  $omerListen = Start-Process node -ArgumentList @($bin, 'listen', '--home', $omerHome, '--json') `
    -RedirectStandardOutput $omerLog -RedirectStandardError (Join-Path $work 'omer-listen.err') -WindowStyle Hidden -PassThru
  WaitFor 'omer ready' { (Test-Path $omerLog) -and (Select-String -Path $omerLog -Pattern '"event":\s*"ready"' -Quiet) } | Out-Null
  WaitFor 'john ready' { Remote "grep -q ready $johnHome/listen.log && echo ok || true" } | Out-Null

  Write-Host '- omer requests contact by email'
  Rdv contact request $johnEmail --greeting "Omer's agent would like to plan dinner." | Out-Null

  Write-Host '- omer waits for the grant (candidate event) and confirms it'
  WaitFor 'candidate event' { Select-String -Path $omerLog -Pattern '"event":\s*"candidate"' -Quiet } | Out-Null
  $cand = Get-Content $omerLog | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.event -eq 'candidate' } | Select-Object -First 1
  Rdv contact confirm $cand.grant_id | Out-Null

  $text = "Thursday 20:00? ($tag)"
  Write-Host '- omer sends a message'
  $payload = @{ type = 'a2a/message'; text = $text } | ConvertTo-Json -Compress
  if ($PSVersionTable.PSVersion -lt [version]'7.3') { $payload = $payload.Replace('"', '\"') }  # PS5 strips bare inner quotes
  node $bin send $johnId --payload $payload --home $omerHome; if ($LASTEXITCODE) { throw "rdv send failed" }  # send takes --json as a value, so no global --json here

  Write-Host "- john's inbox (on $Remote) shows it"
  WaitFor 'message in john inbox' { Remote "$rdvRemote inbox --home $johnHome --json" 2>$null | Select-String -SimpleMatch $text -Quiet } | Out-Null
  Write-Host "PASS two-machine contact scenario via $Relay (omer $($omerId.Substring(0,12))... -> john $($johnId.Substring(0,12))... on $Remote)"
  $code = 0
} catch {
  Write-Host "FAIL $_"
  $code = 1
} finally {
  if ($omerListen) { Stop-Process -Id $omerListen.Id -Force -ErrorAction SilentlyContinue }
  try { Remote "kill `$(cat $johnHome/listen.pid) 2>/dev/null; rm -rf $johnHome" } catch {}
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
exit $code

