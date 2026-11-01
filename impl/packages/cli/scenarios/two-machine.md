# Two-machine contact scenario

John runs on a remote host (relay-host), Omer on this machine, both through the same
relay. Verified 2026-10-25 against `ws://<relay-host>:7777` (strfry on relay-host,
Tailscale), twice.

## One-time setup on the remote

Node >= 20, then a checkout of the branch (it need not be pushed):

```bash
# local, from the repo root
git archive --format=tar.gz -o rdv.tgz HEAD && scp rdv.tgz user@<relay-host>:/tmp/
# remote
mkdir -p ~/src/rendezvous-test && tar xzf /tmp/rdv.tgz -C ~/src/rendezvous-test
cd ~/src/rendezvous-test/impl && npm install && npm run build
```

Local: `npm install && npm run build` in `impl/`.

## Run it (scripted, repeatable)

```powershell
cd impl
$env:RDV_LIVE_RELAYS = 'ws://<relay-host>:7777'; $env:RDV_REMOTE = 'user@<relay-host>'
pwsh packages/cli/scenarios/two-machine.ps1                       # relay and host from the env vars
pwsh packages/cli/scenarios/two-machine.ps1 -Relay wss://nos.lol -Remote user@<relay-host>
```

It uses a fresh random plus-address and temp homes each run, prints `PASS`
or `FAIL <reason>` (exit 0/1), and always stops its listeners and deletes its
temp dirs on both machines. The relay is never touched.

## By hand (what the script does)

Remote (John, bash):

```bash
RDV="node ~/src/rendezvous-test/impl/packages/cli/dist/src/bin.js"
$RDV init --profile john --email john@doe.com --relay ws://<relay-host>:7777 --home /tmp/john
$RDV whoami --home /tmp/john                       # note the agent ID
$RDV listen --auto-grant friend --auto-grant-any-tier --home /tmp/john   # leave running (demo only)
```

Local (Omer, PowerShell):

```powershell
$h = "$env:TEMP\omer"; $rdv = 'packages/cli/dist/src/bin.js'
node $rdv init --profile omer --email omer@example.com --relay ws://<relay-host>:7777 --home $h
Start-Process node -ArgumentList $rdv,'listen','--home',$h -WindowStyle Hidden `
  -RedirectStandardOutput "$h\listen.log"          # or just run `listen` in a second terminal
node $rdv contact request john@doe.com --greeting "Omer's agent would like to plan dinner." --home $h
# wait for "candidate" in $h\listen.log (John's auto-grant), check the fingerprint, then:
node $rdv contact confirm <grant-id> --home $h
node $rdv send <john-agent-id> --payload '{"type":"note","text":"Thursday 20:00?"}' --home $h
```

(PowerShell 5 needs the inner quotes escaped: `'{\"type\":...}'`.)

Back on the remote: `$RDV inbox --home /tmp/john` shows Omer's message.
Stop `listen` and `rm -rf /tmp/john` when done.
