# Deploy rdv-gateway

`rdv-gateway` puts your Rendezvous agent behind an HTTPS address so cloud assistants (claude.ai, ChatGPT, Claude Code on another machine, a Custom GPT) can use it. This guide runs it in a hardened Docker container on a machine that is always on (a home server, a NAS, a small VPS), reachable only through a TLS tunnel or reverse proxy. It was written from a working deployment, with every host name replaced by a placeholder: `gw.example.com` is your public address, and `~/rdv-gateway` is the deploy folder.

The gateway runs the same tools as `rdv-mcp`, minus your setup (`rdv_init`, address and relay changes, turning auto-approve on, local file paths). Nothing is approved through the assistant: a step that needs you returns an approval link, and you decide on the gateway's own PIN-locked page. Read the [threat model](https://github.com/omernesh/rendezvous/blob/main/impl/packages/gateway/THREAT-MODEL.md) before you expose it, and the design notes (NOTES 89 and 93 in [impl/NOTES.md](https://github.com/omernesh/rendezvous/blob/main/impl/NOTES.md)) if you want the reasons. The tool and flag reference is in the gateway section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md).

## What you need

- A machine with Docker and the Compose plugin, and `git`.
- A public HTTPS name for it, such as `gw.example.com`, served by a TLS tunnel (Cloudflare Tunnel is what this guide shows) or a reverse proxy that forwards to `127.0.0.1:8787`.
- A terminal you control on that machine (over `ssh -t` is fine) for the owner-only commands.

## 1. Get the code and build it

Keep the deployment in its own checkout, separate from any development copy, so an update is a deliberate step.

```bash
mkdir -p ~/rdv-gateway && cd ~/rdv-gateway
git clone https://github.com/omernesh/rendezvous.git repo
mkdir -m 700 data
```

Build inside the pinned Node image as uid 1000, so nothing on the host needs Node and the files are owned by the user the container will run as:

```bash
docker run --rm -u 1000:1000 -v "$PWD/repo:/app" -w /app/impl node:22-alpine \
  sh -c 'npm ci && npm run build'
```

If your login user is not uid 1000, run `sudo chown -R 1000:1000 repo data` first. For a stricter pin, replace `node:22-alpine` with a full tag or `@sha256:` digest, here and in `.env` below, and use the same image for both.

## 2. Compose files

Create these three files in `~/rdv-gateway`.

`.env` (not committed anywhere; no secrets in it, only your address):

```bash
NODE_IMAGE=node:22-alpine
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

`gw`, a wrapper for the owner-only commands (then `chmod +x gw`):

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

## 3. Create the agent and the PIN (before the first start)

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

### Moving to your real identity later

Do not run `init` again over a real agent. Make an encrypted backup of the real agent on the machine that has it (see the backup section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md); you type the passphrase in your own terminal), copy the one file to the server, stop the gateway, and restore it over the test identity:

```bash
docker compose stop gateway
mkdir -p backup && cp /path/to/agent.backup backup/
docker compose run --rm -v "$PWD/backup:/backup:ro" gateway \
  node packages/cli/dist/src/bin.js restore /backup/agent.backup --home /data --replace
docker compose up -d
```

It shows the agent ID and fingerprint in the file and asks for the passphrase. Your contacts are told on the next start, so conversations carry on. Only one machine should receive for an agent, so stop `rdv listen` or `rdv-mcp` on the old one. Delete the backup copy from the server when done, and keep the passphrase apart from the file.

## 4. Expose it through a tunnel or proxy

Point your TLS endpoint at `127.0.0.1:8787` and nothing else. **Never bind the gateway to the LAN or a public interface.** The gateway refuses to by default, and `network_mode: host` is only safe because it listens on loopback.

With a Cloudflare Tunnel, add a public hostname for `gw.example.com` whose service is `http://127.0.0.1:8787` (or, in `cloudflared` config, `ingress: - hostname: gw.example.com` with `service: http://127.0.0.1:8787`). `cloudflared` must run on the same host.

With another reverse proxy, terminate TLS, forward to `http://127.0.0.1:8787`, keep the original `Host`, turn response buffering off (the MCP stream is long-lived), and set a header with the real client address that a client cannot forge, for example nginx `proxy_set_header X-Real-IP $remote_addr;` with `GW_CLIENT_IP_HEADER=x-real-ip`. The gateway uses that header to count wrong PINs per client, so a stranger cannot use up your attempts. A header the proxy does not overwrite defeats this.

## 5. Check it

```bash
curl -s https://gw.example.com/healthz                         # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://gw.example.com/openapi.json   # 200
curl -si https://gw.example.com/mcp | head -n 5                # 401, with WWW-Authenticate: Bearer ... resource_metadata="..."
curl -si https://gw.example.com/api/v1/tools | head -n 5       # 401, same header
curl -s https://gw.example.com/.well-known/oauth-protected-resource
```

From a different machine on your LAN, `curl http://<server-lan-address>:8787/healthz` must be refused. If it answers, the gateway is bound too widely: stop it and look at the `--host` value.

## 6. Connect your assistants

The MCP address is `https://gw.example.com/mcp`.

- **claude.ai:** Settings, Connectors, Add custom connector. Paste the URL. Leave the client ID and secret empty so it registers itself ("Register automatically").
- **ChatGPT:** turn on developer mode (Settings, Connectors, Advanced), create a connector with the same URL, and choose OAuth.
- **Claude Code:** `claude mcp add --transport http rendezvous https://gw.example.com/mcp`, then run `/mcp` inside Claude Code and authenticate.
- **A Custom GPT Action, or a script:** these use a static bearer token instead of OAuth. Make one in your terminal with the `token create` command (see the gateway section of [CLI and library](https://rendezvous.nesher.co/docs/cli.md); give it the narrowest scopes: `read`, `send`, `contact:request`, `negotiate`). It is shown once. In the GPT's Action, import `https://gw.example.com/openapi.json` and set authentication to API key, Bearer. Revoke with `token revoke <id>`.

OAuth connectors send your browser to the gateway's consent page. **Check the return address on that page before you approve**: anyone can register an app under any name, so trust the host it returns to (`claude.ai`, `chatgpt.com`), not the name. You unlock the page with your PIN, can untick scopes, and approve. Nothing is approved automatically, and no scope can approve a contact, a task or a dinner: those wait for you on the page.

See and end connections with `./gw oauth list` and `./gw oauth revoke <cli_...|grt_...>`.

## 7. Update

```bash
cd ~/rdv-gateway/repo && git fetch origin && git checkout <tag-or-commit> && cd ..
docker run --rm -u 1000:1000 -v "$PWD/repo:/app" -w /app/impl node:22-alpine \
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
