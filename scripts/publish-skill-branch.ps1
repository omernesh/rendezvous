# Publishes the `skill` branch: the skill folder as the repository root, for
# installers that need SKILL.md at the root of a ref (OpenClaw:
# `openclaw skills install git:omernesh/rendezvous@skill`).
#
# The branch is generated from plugins/rendezvous/skills/rendezvous with
# `git subtree split`, so the skill text exists once. Run it from a clean
# checkout of main after the skill changes; it force-pushes `skill`.
#
#   scripts/publish-skill-branch.ps1 [-Remote origin]
param([string]$Remote = 'origin')
$ErrorActionPreference = 'Stop'
$Prefix = 'plugins/rendezvous/skills/rendezvous'
$Branch = 'skill'

function Fail([string]$m) { Write-Host "publish-skill-branch: $m" -ForegroundColor Red; exit 1 }

Set-Location (& git rev-parse --show-toplevel)
if (-not (Test-Path "$Prefix/SKILL.md")) { Fail "$Prefix/SKILL.md not found" }
if (& git status --porcelain -- $Prefix) { Fail "uncommitted changes in $Prefix" }

$sha = (& git subtree split "--prefix=$Prefix" HEAD)
if ($LASTEXITCODE -ne 0 -or -not $sha) { Fail 'git subtree split failed' }
$sha = $sha.Trim()
if (-not ((& git ls-tree --name-only $sha) -contains 'SKILL.md')) { Fail "SKILL.md is not at the root of $sha" }
& git push --force $Remote "${sha}:refs/heads/$Branch"
if ($LASTEXITCODE -ne 0) { Fail 'git push failed' }
Write-Host "published $Branch at $sha"
Write-Host "install: openclaw skills install git:omernesh/rendezvous@$Branch   (pin with @$sha)"
