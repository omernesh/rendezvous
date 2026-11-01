# Deploy rdv-gateway

`rdv-gateway` puts your Rendezvous agent behind an HTTPS address so cloud assistants (claude.ai, ChatGPT, Claude Code on another machine, a Custom GPT) can use it. This guide runs it in a hardened Docker container on a machine that is always on (a home server, a NAS, a small VPS), reachable only through a TLS tunnel or reverse proxy. It was written from a working deployment, with every host name replaced by a placeholder: `gw.example.com` is your public address, and `~/rdv-gateway` is the deploy folder.

The gateway runs the same tools as `rdv-mcp`, minus your setup (`rdv_init`, address and relay changes, turning auto-approve on, local file paths). Nothing is approved through the assistant: a step that needs you returns an approval link, and you decide on the gateway's own PIN-locked page. Read the [threat model](https://github.com/omernesh/rendezvous/blob/main/impl/packages/gateway/THREAT-MODEL.md) before you expose it, and the design notes (NOTES 89 and 93 in [impl/NOTES.md](https://github.com/omernesh/rendezvous/blob/main/impl/NOTES.md)) if you want the reasons. The tool and flag reference is in the gateway section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md).

## Install with one command

On the machine that will run it (Linux, a NAS, or macOS), in your own terminal (over `ssh -t` is fine):

```bash
curl -fsSL https://rendezvous.nesher.co/install-gateway.sh | sh
```

It asks one question at a time, with the default in brackets (press Enter to take it), and does everything in the steps below:

1. **Folder**: where it lives (default `~/rendezvous-gateway`: the code in `repo/`, your agent in `data/`). It must be new, empty or an earlier install, belong to you, and not be a system or shared folder (`/`, `/tmp`, your home itself, a NAS volume's top or its `docker` share). `--ref` takes only a branch, a tag or a commit on one of them, and an update says which it installs.
2. **Runtime**: Docker Compose in the hardened container shown below (preferred), or Node.js 20+ as a service of your user (systemd on Linux, launchd on macOS). It says exactly what is missing if neither is ready.
3. **Public address**: a Cloudflare Tunnel on your own domain (you paste the tunnel token from the Cloudflare dashboard; it is saved in `cloudflared.token`, mode 600, never shown, and given to `cloudflared --token-file`, so no environment variable or `docker inspect` shows it), a Cloudflare quick tunnel to try it out (a random `trycloudflare.com` address that changes on every restart), your own reverse proxy, or Tailscale Funnel. The gateway itself only ever listens on `127.0.0.1`. The tunnel or proxy forwards the whole hostname (every path, including each agent's `/a/<name>/…` and `/.well-known/oauth-protected-resource/a/…`); the installer sets no path allowlist.
4. **Build**: clones the repository and builds it in the pinned Node image (`node:22-alpine` by digest), as your user; on a NAS under `sudo`, as root (0:0) in a container with every capability dropped, so the code stays root's.
5. **Agent**: a new one (email, relays: `wss://relay.nesher.co` plus the default public relays, and whether it is findable by email), or a restore from your `.rdvbackup` file. For a restore, `rdv restore` shows the agent ID and fingerprint and asks for the passphrase itself.
6. **PIN**: runs `rdv-gateway pin set`, which asks for the approval PIN twice, with nothing shown.
7. **Start**: starts it, waits for `/healthz` locally and on the public address, and prints the MCP address with the steps for claude.ai, ChatGPT and Claude Code, and the `token create` command for clients that need a token (it never makes one for you).

It writes `./gw` in the folder for everything after that: `./gw status`, `./gw logs` (`./gw logs tunnel`), `./gw stop` / `./gw start`, `./gw update` (pull, rebuild, restart, keeping your answers), `./gw backup <file>`, `./gw rdv <command>`, `./gw pin set`, `./gw token create ...`, `./gw oauth list`, `./gw agent add <name> …` (another agent on the same gateway, then `./gw restart`; see "Several agents on one gateway"), and `./gw uninstall` (stops and removes the service; your agent stays in `data/` until you delete it). Running the installer again also updates.

Every answer that is not a secret is also a flag, for a scripted install or one your assistant prepares (the `rdv-gateway-setup` skill of the Claude Code plugin does that): `--dir`, `--runtime docker|node`, `--ref`, `--port`, `--agent new|restore`, `--email` (repeat), `--relay` (repeat), `--public-pointer`, `--backup`, `--tunnel cloudflare-token|cloudflare-quick|own-url|tailscale`, `--public-url`, `--client-ip-header`, `--yes` and `--dry-run` (shows every command and file, changes nothing). See `sh install-gateway.sh --help`. The PIN, a backup passphrase and a tunnel token are never flags. It refuses to run as root; on a NAS where only root can use Docker, run it with `sudo` and `--allow-root`: it asks which normal user the gateway runs as (default: the one who ran `sudo`; `--uid` to name another), and only `data/` becomes theirs, while the code, the installer copy `./gw update` runs, and `./gw` stay root's. If your user can use Docker (the docker group, or rootless Docker), no root is needed. Under `sudo`, pass `--dir` explicitly, since the default follows `$HOME`, which may be yours or root's. On a Synology NAS use `--dir /volume1/rendezvous-gateway`, beside the shares and not inside one (it is the default there). Only root can create a folder in `/volume1`, so on a NAS run the installer with `sudo` (and `--allow-root`). Being in the docker group is not enough there, and a folder under your DSM home is no way around it: homes live in the `homes` share (`/volume1/homes`, `drwxrwxrwx+`), which the installer refuses for the same reason. Why: `/` and `/volume1` belong to root (mode 755), while a share such as `/volume1/docker` has an ACL that lets other accounts write in it (on DSM even `anon`). Whoever can rename an entry in any folder above the install could swap the whole install between runs, and Docker would then start their code with your `data/` mounted, or `sudo ./gw update` would run their `./gw` as root. So the installer refuses an install folder under any folder, all the way up to `/`, that someone other than you or root can write without the sticky bit, or whose ACL lets anyone else write or delete (it reads `synoacltool` on DSM and `getfacl` elsewhere). The folder itself must be yours and private (700, no ACL; on DSM it removes an inherited ACL); a home whose group is your own user private group (Debian, Ubuntu, Fedora) is fine. Windows: run it inside WSL 2.

With Cloudflare, turn off Email Obfuscation for the gateway's hostname (see step 4 below). The rest of this page is the same setup by hand, and what the installer writes.

## By hand

### What you need

- A machine with Docker and the Compose plugin, and `git`.
- A public HTTPS name for it, such as `gw.example.com`, served by a TLS tunnel (Cloudflare Tunnel is what this guide shows) or a reverse proxy that forwards to `127.0.0.1:8787`.
- A terminal you control on that machine (over `ssh -t` is fine) for the owner-only commands. They refuse to run unless stdin and stdout are both a terminal (issue #126): `ssh` without `-t`, a script, a pipe, `docker compose run -T`, or `docker exec` without `-it` gets a refusal and changes nothing. That is what keeps an assistant with a shell from running them.

### 1. Get the code and build it

Keep the deployment in its own checkout, separate from any development copy, so an update is a deliberate step.

```bash
mkdir -p ~/rdv-gateway && cd ~/rdv-gateway
git clone https://github.com/omernesh/rendezvous.git repo
mkdir -m 700 data
```

Build inside the pinned Node image as your own login user (run these as that user, not as root), so nothing on the host needs Node and the files belong to you:

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/repo:/app" -w /app/impl node:22-alpine \
  sh -c 'npm ci && npm run build'
```

Never chown the code to another user: whoever can write `repo/` decides what the gateway runs. For a stricter pin, replace `node:22-alpine` with a full tag or `@sha256:` digest, here and in `.env` below, and use the same image for both.

### 2. Compose files

Create these three files in `~/rdv-gateway`.

`.env` (not committed anywhere; no secrets in it, only your address):

```bash
NODE_IMAGE=node:22-alpine
# Your own uid and gid (id -u, id -g): the gateway runs as you and owns only data/
RDV_UID=1000
RDV_GID=1000
GW_PORT=8787
GW_PUBLIC_URL=https://gw.example.com
# The header your proxy sets to the real client address (Cloudflare: cf-connecting-ip)
GW_CLIENT_IP_HEADER=cf-connecting-ip
```

`docker-compose.yml`:

```yaml
services:
  gateway:
    image: ${NODE_IMAGE}
    working_dir: /app/impl
    command:
      - node
      - packages/gateway/dist/src/bin.js
      - serve
      - --home
      - /data
      - --host
      - 127.0.0.1
      - --port
      - "${GW_PORT}"
      - --public-url
      - ${GW_PUBLIC_URL}
      - --client-ip-header
      - ${GW_CLIENT_IP_HEADER}
    network_mode: host          # the tunnel runs on this host and reaches 127.0.0.1
    user: "${RDV_UID}:${RDV_GID}"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
    volumes:
      - ./repo:/app:ro
      - ./data:/data            # the agent's home: key, contacts, PIN hash, tokens
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:${GW_PORT}/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
```

`gw`, a wrapper for the owner-only commands (then `chmod +x gw`). Keep `docker compose run` without `-T`, so the command gets your terminal; if you run one in the running container instead, use `docker compose exec gateway …` (it gives the command your terminal unless you pass `-T`) or `docker exec -it <container> …` (plain `docker exec` without `-it` has no terminal and is refused):

```bash
#!/bin/sh
# ./gw <gateway command...>      runs rdv-gateway against the deployed home
# ./gw rdv <rdv command...>      runs the rdv CLI against the same home
cd "$(dirname "$0")" || exit 1
if [ "$1" = rdv ]; then
  shift
  exec docker compose run --rm gateway node packages/cli/dist/src/bin.js "$@" --home /data
fi
exec docker compose run --rm gateway node packages/gateway/dist/src/bin.js "$@" --home /data
```

The flag names are the ones in `impl/packages/gateway/src/bin.ts`. With an `https` `--public-url` the gateway refuses to start without `--client-ip-header`, and it refuses to bind anything but a local address unless you pass `--allow-remote-bind`, which this setup never does.

### 3. Create the agent and the PIN (before the first start)

The server refuses to start until you have set an approval PIN, and with `restart: unless-stopped` a missing PIN would loop. So do these first, in your own terminal, one command at a time.

**Use a dedicated test identity for the first run.** It lets you try every connector without your real contacts at stake, and it stays off the public discovery topics (the public pointer is off unless you pass `--public-pointer`):

```bash
./gw rdv init --email gateway-test@example.com
```

Then set the PIN. This one needs a real terminal, so from your laptop use `ssh -t you@your-server` and run it inside that session. **Paste commands one at a time**: if you paste several lines, the later ones are typed into the PIN prompt and become your PIN.

```bash
./gw pin set
```

It asks for the new PIN (6 or more characters) and then again; nothing is shown as you type. Choose something you do not use elsewhere: the PIN is what separates an assistant that can call tools from you approving things.

Start it:

```bash
docker compose up -d
docker compose ps        # gateway should become "healthy"
docker compose logs gateway
```

#### Moving to your real identity later

Do not run `init` again over a real agent. Make an encrypted backup of the real agent on the machine that has it (see the backup section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md); you type the passphrase in your own terminal), copy the one file to the server, stop the gateway, and restore it over the test identity:

```bash
docker compose stop gateway
mkdir -p backup && cp /path/to/agent.backup backup/
docker compose run --rm -v "$PWD/backup:/backup:ro" gateway \
  node packages/cli/dist/src/bin.js restore /backup/agent.backup --home /data --replace
docker compose up -d
```

It shows the agent ID and fingerprint in the file and asks for the passphrase. Your contacts are told on the next start, so conversations carry on. Only one machine should receive for an agent, so stop `rdv listen` or `rdv-mcp` on the old one. Delete the backup copy from the server when done, and keep the passphrase apart from the file.

### 4. Expose it through a tunnel or proxy

Point your TLS endpoint at `127.0.0.1:8787` and nothing else. **Never bind the gateway to the LAN or a public interface.** The gateway refuses to by default, and `network_mode: host` is only safe because it listens on loopback.

With a Cloudflare Tunnel, add a public hostname for `gw.example.com` whose service is `http://127.0.0.1:8787` (or, in `cloudflared` config, `ingress: - hostname: gw.example.com` with `service: http://127.0.0.1:8787`). `cloudflared` must run on the same host.

**If you use Cloudflare:** turn off Email Obfuscation for the gateway's hostname (Rules → Configuration Rules → hostname equals `gw.example.com` → Email Obfuscation: Off), and keep Rocket Loader and Auto Minify off for it. Obfuscation masks addresses on the approval page as "[email protected]", and its decoder script is blocked by the page's CSP, so you would be deciding without seeing who it is. The gateway sends `Cache-Control: no-store, no-transform` on every response, so most proxies leave the pages alone, but turn these off anyway.

With another reverse proxy, terminate TLS, forward to `http://127.0.0.1:8787`, keep the original `Host`, turn response buffering off (the MCP stream is long-lived), and set a header with the real client address that a client cannot forge, for example nginx `proxy_set_header X-Real-IP $remote_addr;` with `GW_CLIENT_IP_HEADER=x-real-ip`. The gateway uses that header to count wrong PINs per client, so a stranger cannot use up your attempts. A header the proxy does not overwrite defeats this.

### 5. Check it

```bash
curl -s https://gw.example.com/healthz                         # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://gw.example.com/openapi.json   # 200
curl -si https://gw.example.com/mcp | head -n 5                # 401, with WWW-Authenticate: Bearer ... resource_metadata="..."
curl -si https://gw.example.com/api/v1/tools | head -n 5       # 401, same header
curl -s https://gw.example.com/.well-known/oauth-protected-resource
```

From a different machine on your LAN, `curl http://<server-lan-address>:8787/healthz` must be refused. If it answers, the gateway is bound too widely: stop it and look at the `--host` value.

### 6. Connect your assistants

The MCP address is `https://gw.example.com/mcp`.

- **claude.ai:** Settings, Connectors, Add custom connector. Paste the URL. Leave the client ID and secret empty so it registers itself ("Register automatically").
- **ChatGPT:** turn on developer mode (Settings, Connectors, Advanced), create a connector with the same URL, and choose OAuth.
- **Claude Code:** `claude mcp add --transport http rendezvous https://gw.example.com/mcp`, then run `/mcp` inside Claude Code and authenticate.
- **A Custom GPT Action, or a script:** these use a static bearer token instead of OAuth. Make one on the gateway's settings page (`https://gw.example.com/approve/admin`, below), or in your terminal with the `token create` command (see the gateway section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md)). Give it the narrowest scopes: `read`, `send`, `contact:request`, `negotiate`. It is shown once. In the GPT's Action, import `https://gw.example.com/openapi.json` and set authentication to API key, Bearer. Revoke it on the same page (or with `token revoke <id>`).

OAuth connectors send your browser to the gateway's consent page. **Check the return address on that page before you approve**: anyone can register an app under any name, so trust the host it returns to (`claude.ai`, `chatgpt.com`), not the name. You unlock the page with your PIN, can untick scopes, and approve. Nothing is approved automatically, and no scope can approve a contact, a task or a dinner: those wait for you on the page.

See and end connections on the settings page, or with `./gw oauth list` and `./gw oauth revoke <cli_...|grt_...>`.

#### The settings page

Routine administration needs no terminal: open `https://gw.example.com/approve/admin` (or "Gateway settings" at the bottom of the approval page) and unlock it with your PIN. For each agent it shows:

- **Access tokens**: name, id, scopes and when each was made (never the token itself). Make one (a name, the scopes you tick, nothing ticked to start, and your PIN again): the token is shown once, on that page only. Revoke one: the gateway refuses it at the next request and closes its open sessions.
- **Connected apps (OAuth)**: each connection's app name (what the app called itself), where it returns, scopes and last refresh. Disconnect one, or remove a whole app with every connection it has.
- **Auto-approved contacts**: each contact that no longer needs your approval (fingerprint, your name for it, what it covers), with a Turn off button. Turning it on stays on approval forms ("Don't ask again for this contact").
- **Webhook**: where it posts (scheme and host only), which events, how many wait and how many are dead letters. Turn it off. Setting a webhook stays in the terminal (`./gw notify set`), because it needs a secret file and, for a private address, an allowed host.
- **Your PIN**: change it with the current one and the new one twice. Every unlocked page signs out.

Changes apply to the running gateway at once, like the terminal commands. Your assistants cannot open the page: a request that carries a bearer token is refused there, whatever its scopes, and no tool or API call administers the gateway. Setting the first PIN, `pin unlock`, and adding, removing or migrating agents stay in the terminal. Anyone with your PIN and your address can now make tokens from the network, so keep the PIN as private as before (see the threat model).

### Several agents on one gateway

One gateway can serve several agents: yours and a second one for another assistant, or a family's. `data/` becomes the gateway's root: the PIN, tokens and OAuth state stay there, and each further agent is a normal home in `data/agents/<name>/`. Your existing agent in `data/` keeps working as it is. Every token and every OAuth connection reaches exactly one agent and nothing of the others. One PIN unlocks the approval page for all of them, and every approval says which agent it is for (name and fingerprint), so only put agents on one gateway that you would trust to one machine.

```bash
./gw agent add kids new --email kids@example.com      # a new identity
./gw agent list
docker compose restart gateway                        # agents are read at start
./gw token create --agent kids --name kids-claude --scope read,send
```

To bring an existing agent instead, restore its backup as a new agent, with the backup folder mounted as in "Moving to your real identity" above: `docker compose run --rm -v "$PWD/backup:/backup:ro" gateway node packages/gateway/dist/src/bin.js agent add kids --restore /backup/kids.backup --home /data`. Stop `rdv listen` or `rdv-mcp` for it on the old machine.

Each agent has its own MCP address, `https://gw.example.com/a/kids/mcp` (REST under `/a/kids/api/v1`, OpenAPI at `/a/kids/openapi.json`). `https://gw.example.com/mcp` still works for any token, and serves that token's own agent. An OAuth client connected to an agent's address is fixed to it on the consent page; one connected to `/mcp` makes you pick the agent there. With several agents, give each its own calendar: `--calendar kids=/data/kids-cal.json`.

`./gw agent remove kids` moves the agent to `data/agents/.removed/`, key and all (delete it yourself once you have a backup); it refuses while the gateway runs or while tokens or connections still reach it (`--force` revokes them). To have your first agent in `data/agents/` too, stop the gateway and run `./gw agent migrate`: it copies, checks the copy, and keeps the originals in `data/.premigrate-<time>/`. Migrating is optional.

With the one-command install, the same commands run through its `./gw` helper (`./gw agent add kids new --email kids@example.com`, `./gw agent list`, `./gw token create --agent kids …`, in your own terminal), then `./gw restart`. The installer prints each agent's MCP address at the end.

### Calendars (for meeting negotiation)

Meetings are one thing your agents can do over Rendezvous. To let your agent negotiate a time on its own, give it a calendar file. It is a JSON list of busy intervals (RFC 3339 with offsets); `timezone` is optional and is a fixed offset used to read phrases like `--window`:

```json
{
  "timezone": "+02:00",
  "busy": [
    { "start": "2026-11-05T19:00:00+02:00", "end": "2026-11-05T21:00:00+02:00", "title": "Dentist" }
  ]
}
```

Put the file under `data/` (for example `data/calendar.json`), which the container sees as `/data`; the gateway runs as your uid, so that user must be able to read it. Then add the flag to the `command` list in `docker-compose.yml` and restart the gateway (`docker compose restart gateway`, or `./gw restart`); the file is not picked up until then:

```yaml
      - --calendar
      - /data/calendar.json
```

With one agent, `--calendar <file>` is enough. With several agents, name whose calendar it is: `--calendar omer=/data/omer-cal.json`, once per agent (a single bare file is refused). An agent without a calendar has nothing to offer for meetings; its messages, tasks and files are unaffected. Only free/busy leaves the file: the other agent sees which times are free, never the `title`s.

### Notifications (webhooks)

Your assistant only hears about an accepted invite when it next reads its inbox. To be told the moment it happens, have the gateway POST each event to a receiver of yours (a small service that messages you, for example). Per agent:

```bash
openssl rand -hex 32 > data/notify.secret && chmod 600 data/notify.secret
./gw notify set omer --url https://hooks.example.com/rdv --secret-file /data/notify.secret
./gw notify set omer --url http://100.101.102.103:8080/rdv --allow-insecure-host 100.101.102.103 --secret-file /data/notify.secret
./gw notify show                     # every agent's receiver (scheme and host), events, waiting events and dead letters (also on the settings page)
./gw notify dead-letter omer         # events given up on; --retry sends them again (same ids)
./gw notify clear omer
```

In PowerShell, write the secret as ASCII (`>` and `Out-File` write UTF-16, which is refused):
`$s = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)); [IO.File]::WriteAllText("$PWD\notify.secret", $s, [Text.Encoding]::ASCII)`.

- **The secret:** `notify set` copies it into the gateway root as `notify-<agent>.secret` (mode 600), so the file you gave may be deleted. Give your receiver the same value. It must be printable ASCII and at least 16 characters long; only ASCII white space at the ends is trimmed. To rotate it, run `notify set` again with a new file: for 24 h every request carries two signatures, the new one first, so receivers can switch over at their own pace.
- **Events:** `invite_redeemed`, `invite_expired` (an open invite passed its expiry unused; sent once) and `invite_exposed` by default; add `contact_request`, `contact` (a new contact) and `message` with `--events a,b,…`. Only events from the moment you set it are sent. While a request event waits to go out (the receiver is slow or down), newer requests are merged into it, from any sender: one event with a `count`, the latest request's fields and its last five senders. Messages from one contact are merged the same way.
- **The URL:** `https`, or `http` only to a host you allow with `--allow-insecure-host`: a host name, an IP address, or a range such as `100.64.0.0/10` (Tailscale). The gateway refuses private, CGNAT, loopback, link-local and metadata addresses, also when a name resolves to one. An allowed name or range opens only private ones. Loopback and `169.254.169.254` open only when you name that exact IP. The gateway follows no redirects.
- **Each request:** `POST`, `Content-Type: application/json`, one event:

  ```json
  {"v":1,"id":"evt_…","event":"invite_redeemed","agent":"rdv1:…","agent_name":"omer","at":"2026-11-01T09:30:00.000Z",
   "data":{"invite_id":"0123456789abcdef","tier":"friend","label":"Dana","redeemer_fingerprint":"…"}}
  ```

  - `invite_expired`: `invite_id`, `tier`, `label`, `expired_at`
  - `invite_exposed`: `invite_id`, `label`, `from_fingerprint`
  - `contact_request`: `request_id`, `from_fingerprint`, `binding`, `greeting` (all of the latest), `count`, `recent_fingerprints` (up to 5, the latest first)
  - `contact`: `fingerprint`, `label`, `tier`, `binding`
  - `message`: `from_fingerprint`, `label`, `seq` (of the first), `count`

  `label` is your own name for the person, or `null`. Text a peer wrote (a greeting) comes only as `{"untrusted_peer_text": "…"}`. A request never carries an invite link or its secret, a key, or message text.
- **Signature:** `X-Rdv-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`, with a second `v1=` during a rotation. Your receiver must:
  - check the signature on the raw bytes before parsing, and accept the request when any `v1=` matches;
  - compare in constant time;
  - reject a `t` more than 300 s from its clock;
  - dedupe by `id` on disk: delivery is at least once, and a retry carries the same `id` and body.
- **Delivery:** within a few seconds, from an outbox in `data/gateway-notify.json` that survives restarts. A 2xx is delivered. Network errors, timeouts (10 s), `429` and `5xx` are retried with exponential backoff for up to 24 h; any other answer is not retried. Both kinds of give-up land in the dead letters. Each agent has its own delivery slot and agents take turns, so one agent's stuck receiver never holds up another's. Per agent, at most 250 events wait and 125 dead letters are kept (1000 and 500 in all). An agent over its share loses only its own items: requests and messages first, then contacts, and invite events only when nothing else is left. Dead letters belong to the agent's identity: an agent that later takes the same name never sees them. If `gateway-notify.json` does not pass its checks, the gateway refuses to start and says why. A webhook only receives; nothing it answers can approve, grant or revoke anything.

[`notify-receiver.py`](https://github.com/omernesh/rendezvous/blob/main/docs/notify-receiver.py) is a complete receiver in about 70 lines of standard-library Python. It checks the signature (several secret files allowed, for rotation) and the timestamp, refuses bodies over 64 KiB, handles at most 8 requests at once with 15 s each, and dedupes in SQLite. Run it as `python3 notify-receiver.py 8080 100.101.102.103`; it binds `127.0.0.1` unless you give an address. From TypeScript, `verifyRdvSignature(secret | secrets[], header, rawBody)` in `@rendezvous/gateway` does the check.

With the one-command install, run the same commands through its `./gw` helper (`./gw notify set omer --url … --secret-file …`).

### 7. Update

```bash
cd ~/rdv-gateway/repo && git fetch origin && git checkout <tag-or-commit> && cd ..
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/repo:/app" -w /app/impl node:22-alpine \
  sh -c 'npm ci && npm run build'
docker compose up -d --force-recreate
```

Read the [changelog](https://rendezvous.nesher.co/changelog.md) first. Approvals that are waiting on the page live in memory and are dropped by the restart; the assistant asks again. Tokens, OAuth connections, the PIN and your contacts are on disk in `data/` and survive.

## Troubleshooting

- **Container restarts in a loop:** `docker compose logs gateway`. No PIN set, or `--public-url` without `--client-ip-header`, stop it at start with a clear message.
- **Wrong-PIN wait:** after several wrong PINs the page makes you wait. `./gw pin unlock` clears it.
- **Consent page loops back to the PIN form:** the owner cookie is Secure when the public URL is `https`, so use the public address, not `http://127.0.0.1:8787`, for `/approve`.
- **`permission denied` on `/data`:** the folder must belong to the uid in `.env` and be mode 700.
- **Backup of the deployment:** back up `data/` while the gateway is stopped, and keep it as private as the key it holds. It contains the agent's key, the PIN hash and the OAuth signing key.
- **Addresses show as "[email protected]":** the proxy is rewriting the HTML (Cloudflare's Email Obfuscation), and its decoder script is blocked by the page's CSP. The gateway sends `Cache-Control: no-store, no-transform`, which Cloudflare honours by skipping the rewrite. If you still see it, turn off Email Obfuscation for the gateway host.
