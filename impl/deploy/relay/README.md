# Rendezvous dev relay (strfry)

Image: `ghcr.io/hoytech/strfry` pinned by digest (only `:latest` is published; digest is strfry 1.1.2-148-g4cd3cf6).
No auth, all kinds accepted (incl. 30417), max event 64 KB, websocket ping every 55 s.
No per-IP rate limit: strfry has none built in (needs a writePolicy plugin; Cloudflare rules can cover the public hostname).

## Deploy (relay-host)
    scp docker-compose.yml strfry.conf backup.sh README.md user@<relay-host>:~/docker/rendezvous-relay/
    ssh user@<relay-host> 'cd ~/docker/rendezvous-relay && chmod +x backup.sh && mkdir -p data && docker compose up -d'

Ports: `127.0.0.1:7777`, the Tailscale IP `<relay-host>:7777`, and the LAN IP `<lan-ip>:7777` for the tunnel connector (never 0.0.0.0).
Data: `~/docker/rendezvous-relay/data` (local disk; never put LMDB on <nas>, which is CIFS).
The compose file hardcodes the Tailscale IP; change it if relay-host's tailnet address changes.

## Health check
    curl -H 'Accept: application/nostr+json' http://127.0.0.1:7777
    curl -H 'Accept: application/nostr+json' http://<relay-host>:7777   # from any tailnet machine
    # test clients: ws://<relay-host>:7777

## Backup
`backup.sh` runs `strfry export` inside the running container (no stop), writes
`<backup-dir>/strfry-YYYYmmdd-HHMMSS.jsonl.gz`, keeps 7.
Nightly via user crontab: `15 3 * * * $HOME/docker/rendezvous-relay/backup.sh >> $HOME/docker/rendezvous-relay/backup.log 2>&1`
Restore: `zcat file | docker exec -i rendezvous-relay /app/strfry import`

## Public exposure (owner step, Cloudflare dashboard)
Zero Trust > Networks > Tunnels > (existing tunnel) > Public Hostname > Add:
hostname `relay.nesher.co`, service type HTTP, URL `<lan-ip>:7777` (the "home" tunnel connector is not on relay-host, so localhost does not reach it; done 2026-10-25 via the API). WebSockets pass through
by default. Then: `curl -H 'Accept: application/nostr+json' https://relay.nesher.co` and use `wss://relay.nesher.co`.
(`realIpHeader` is set to `cf-connecting-ip` so logs show real client IPs.)
