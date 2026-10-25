# Rendezvous dev relay (strfry)

Image: `ghcr.io/hoytech/strfry` pinned by digest (only `:latest` is published; digest is strfry 1.1.2-148-g4cd3cf6).
No auth, all kinds accepted (incl. 30417), max event 64 KB, websocket ping every 55 s.
No per-IP rate limit: strfry has none built in (needs a writePolicy plugin; Cloudflare rules can cover the public hostname).

## Configure
Host-specific values live in `.env` next to `docker-compose.yml` (gitignored).
Start from the template:

    cp .env.example .env    # then edit

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_BIND_TAILNET` | `127.0.0.1` | Private-network address to listen on, e.g. the host's Tailscale IP |
| `RELAY_PORT_TAILNET` | `17777` | Port on that address (use `7777` once the address is not loopback) |
| `RELAY_BIND_LAN` | `127.0.0.1` | LAN address a tunnel connector uses to reach the relay |
| `RELAY_PORT_LAN` | `27777` | Port on that address (use `7777` once the address is not loopback) |
| `BACKUP_DIR` | none (required by `backup.sh`) | Where `backup.sh` writes exports |

The relay always listens on `127.0.0.1:7777`. Both extra binds default to loopback on
other ports, so an unconfigured host exposes nothing. Never bind `0.0.0.0`.

## Deploy
    scp docker-compose.yml strfry.conf backup.sh .env README.md user@<relay-host>:~/docker/rendezvous-relay/
    ssh user@<relay-host> 'cd ~/docker/rendezvous-relay && chmod +x backup.sh && mkdir -p data && docker compose up -d'

Data: `~/docker/rendezvous-relay/data` (local disk; never put LMDB on a network share such as CIFS).

## Health check
    curl -H 'Accept: application/nostr+json' http://127.0.0.1:7777
    curl -H 'Accept: application/nostr+json' http://$RELAY_BIND_TAILNET:$RELAY_PORT_TAILNET   # from the private network
    # test clients: ws://<relay-host>:7777

## Backup
`backup.sh` runs `strfry export` inside the running container (no stop), writes
`$BACKUP_DIR/strfry-YYYYmmdd-HHMMSS.jsonl.gz`, keeps 7. It reads `BACKUP_DIR` from the
environment, or from `.env` next to the script, and refuses to run without it.
Nightly via user crontab: `15 3 * * * $HOME/docker/rendezvous-relay/backup.sh >> $HOME/docker/rendezvous-relay/backup.log 2>&1`
Restore: `zcat file | docker exec -i rendezvous-relay /app/strfry import`

## Public exposure (owner step, Cloudflare dashboard)
Zero Trust > Networks > Tunnels > (existing tunnel) > Public Hostname > Add:
hostname `relay.nesher.co`, service type HTTP, URL `$RELAY_BIND_LAN:$RELAY_PORT_LAN` (use the LAN bind when the tunnel connector runs on another machine, since localhost does not reach it there). WebSockets pass through
by default. Then: `curl -H 'Accept: application/nostr+json' https://relay.nesher.co` and use `wss://relay.nesher.co`.
(`realIpHeader` is set to `cf-connecting-ip` so logs show real client IPs.)
