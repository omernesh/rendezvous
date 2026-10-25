# Site deployment (rendezvous.nesher.co)

Serves the static site in [`site/`](../../../site) with `nginx:alpine`, read-only.
The page is plain HTML/CSS/JS: no build step, no third-party code.

```bash
cd impl/deploy/site
cp .env.example .env      # then edit; .env is gitignored
docker compose up -d
curl -sI http://127.0.0.1:7778/ | grep -i content-security-policy
curl -s  http://127.0.0.1:7778/install.sh | head -3      # served as text/plain
```

- `.env`: `SITE_BIND_LAN` (default `127.0.0.1`) is the LAN address a tunnel connector uses
  to reach the site, and `SITE_PORT_LAN` (default `17778`) its port. The site always listens
  on `127.0.0.1:7778`; the extra bind defaults to loopback, so an unconfigured host exposes
  nothing. Never bind `0.0.0.0`.
- `docker-compose.yml`: the image is pinned by digest and opted out of watchtower.
  To upgrade, look up the new tag's digest (`docker buildx imagetools inspect nginx:<tag>`)
  and change both the tag and the digest.
- `nginx.conf`: serves `install.sh` and `install.ps1` as `text/plain`, gzips text,
  short cache lifetimes (nothing is fingerprinted).
- `security-headers.conf`: CSP with `'self'` only, `nosniff`, `Referrer-Policy: no-referrer`,
  frame denial. It is included per location because nginx drops inherited `add_header`
  lines in any location that sets its own.

The site is a bind mount, so `git pull` updates it live; nginx needs no restart.
The installers clone `https://github.com/omernesh/rendezvous`.
