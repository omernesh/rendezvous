#!/bin/sh
# Rendezvous gateway installer for Linux, macOS and NAS boxes (POSIX sh).
#
#   curl -fsSL https://rendezvous.nesher.co/install-gateway.sh | sh
#
# Puts your Rendezvous agent behind an HTTPS address so claude.ai, ChatGPT and
# other cloud assistants can use it. It asks one question at a time (the
# default is in brackets: press Enter to take it), builds the gateway, creates
# or restores your agent, has you set the approval PIN, connects a tunnel or
# your own proxy, starts it and checks it. Run it again to update.
#
# Every answer that is not a secret can also be given as a flag, so the same
# install can be scripted or prepared by your assistant:
#
#   curl -fsSL https://rendezvous.nesher.co/install-gateway.sh | sh -s -- --help
#
# Secrets are never flags: the approval PIN, a backup's passphrase and a
# Cloudflare tunnel token are typed in this terminal, with nothing shown.
# The PIN and the passphrase go straight to the Rendezvous commands; this
# script never sees them. No sudo; Docker is the preferred runtime.
#
# Environment overrides:
#   RDV_REPO   git URL or local path to clone (default: https://github.com/omernesh/rendezvous)

# Everything runs from main(), called on the last line, so a download that is
# cut short executes nothing.

set -eu

# Pinned images (tag for people, digest for the machine). Update both together.
NODE_IMAGE_DEFAULT='node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914'
CLOUDFLARED_IMAGE_DEFAULT='cloudflare/cloudflared:2026.10.0@sha256:9b49eed8f62806d5d45ddf59ecefb5710429598ea6d3fcccd2af938f621b2b07'
# A new agent listens here unless you choose other relays: this project's relay, then rdv's default public set.
DEFAULT_RELAYS='wss://relay.nesher.co wss://nos.lol wss://relay.primal.net wss://relay.nostr.net wss://nostr.oxtr.dev'
STEPS=7

usage() {
  cat <<'EOF'
usage: install-gateway.sh [options]

With no options it asks every question. Each option answers one question:

  --dir <path>               install folder (default ~/rendezvous-gateway)
  --runtime docker|node      Docker Compose (default) or Node.js with a user service
  --ref <branch|tag|commit>  what to build (default main)
  --port <n>                 local port on 127.0.0.1 (default 8787)
  --agent new|restore        create a new agent, or restore one from a backup file
  --email <address>          the new agent's email (repeat for more)
  --relay <wss://...>        a relay for the new agent (repeat; default: relay.nesher.co and 4 public relays)
  --public-pointer           make the new agent findable by its email
  --no-public-pointer        keep it unlisted (default)
  --backup <file>            the .rdvbackup file to restore
  --tunnel <mode>            cloudflare-token | cloudflare-quick | own-url | tailscale
  --public-url <https://...> the public address (own-url, cloudflare-token)
  --client-ip-header <name>  the header your proxy puts the client address in (own-url)
  --update                   re-run with the saved settings: pull, rebuild, restart
  --yes                      take the default for any question not answered by a flag
  --dry-run                  show what would happen; change nothing, no network
  --allow-root               allow running as root (only where Docker needs it, e.g. a NAS)
  --uid <n>                  as root: the user id the gateway runs as (default: the one who ran sudo)
  -h, --help                 this text

Never given as options: the approval PIN, a backup passphrase, a tunnel token.
EOF
}

# --- output ------------------------------------------------------------------

die() {
  printf 'rendezvous gateway install: error: %s\n' "$*" >&2
  exit 1
}
warn() { printf 'WARNING: %s\n' "$*" >&2; }
say() { printf '%s\n' "$*"; }
step() { printf '\n==> Step %s of %s: %s\n' "$1" "$STEPS" "$2"; }
done_step() { printf 'Step %s of %s done.\n' "$1" "$STEPS"; }

# One argument, quoted for a shell when it needs it (for showing commands).
shquote() {
  case $1 in
    '' | *[!A-Za-z0-9_./:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}
show_cmd() {
  printf '  $'
  for a in "$@"; do printf ' %s' "$(shquote "$a")"; done
  printf '\n'
}

# Run a command with stdin closed (so nothing reads the rest of a piped script),
# or only show it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then show_cmd "$@"; return 0; fi
  recheck_dir
  "$@" </dev/null
}
# Run a command that asks the human something in this terminal.
run_tty() {
  if [ "$DRY_RUN" = 1 ]; then show_cmd "$@"; return 0; fi
  recheck_dir
  "$@" </dev/tty
}

# Write stdin to a file (mode $2) atomically, or show it with --dry-run.
write_file() {
  if [ "$DRY_RUN" = 1 ]; then
    printf -- '--- would write %s (mode %s)\n' "$1" "$2"
    cat
    printf -- '--- end of %s\n' "$1"
    return 0
  fi
  # Never through a symlink someone left in place, and the temp file is a fresh one only we created.
  [ -z "${DIR:-}" ] || case $1 in "${D:-$DIR}"/* | "$DIR"/*) recheck_dir ;; esac
  [ ! -L "$1" ] || die "$1 is a symbolic link; this installer will not write through it. Remove it, then run this again"
  [ ! -L "$(dirname "$1")" ] || die "$(dirname "$1") is a symbolic link; this installer will not write through it"
  tmp=$(umask 077 && mktemp "$1.XXXXXX") || die "cannot create a temporary file next to $1"
  cat >"$tmp" || { rm -f "$tmp"; die "cannot write $tmp"; }
  chmod "$2" "$tmp" || { rm -f "$tmp"; die "cannot chmod $tmp"; }
  mv -f "$tmp" "$1" || { rm -f "$tmp"; die "cannot move $tmp to $1"; }
}

# --- validation (pure; the tests call these) --------------------------------

has_newline() { [ "$(printf '%s' "$1" | wc -l | tr -d ' ')" != 0 ]; }
matches() { ! has_newline "$2" && printf '%s' "$2" | grep -Eq "$1"; }

valid_https_url() { matches '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' "$1"; }
valid_header() { matches '^[A-Za-z0-9-]{1,64}$' "$1"; }
valid_port() { matches '^[0-9]{1,5}$' "$1" && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_email() { matches '^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$' "$1"; }
valid_relay() { matches '^wss://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' "$1"; }
# A branch, a tag or a commit: never a full ref (refs/pull/… is anyone's pull request), never git revision syntax.
valid_ref() {
  matches '^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$' "$1" || return 1
  case $1 in refs/* | */refs/* | pull/* | *..* | *.lock | */ | *//*) return 1 ;; esac
}
valid_token() { matches '^[A-Za-z0-9+/=_-]{40,4096}$' "$1"; }
# A path we can write into compose files, unit files and shell lines without quoting surprises.
valid_path() {
  matches '^/[A-Za-z0-9._/@+-]*$' "$1" || return 1
  case $1 in *//* | */./* | */../* | */. | */..) return 1 ;; esac
}

# A path with its existing part resolved (cd -P, pwd -P) and the rest appended as given.
physical_path() {
  p=$1 tail=''
  while [ ! -d "$p" ] && [ "$p" != / ]; do
    tail="/$(basename "$p")$tail"
    p=$(dirname "$p")
  done
  real=$(cd -P -- "$p" 2>/dev/null && pwd -P) || real=$p
  out="${real%/}$tail"
  printf '%s' "${out:-/}"
}

# Folders that are never an install folder: system and shared ones, a NAS volume's own top, your home and above it.
system_dir() {
  case $1 in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /media | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /usr/* | /var | /var/tmp | /var/lib | /var/log) return 0 ;;
    /Users | /Library | /Library/* | /System | /System/* | /Applications | /private | /private/* | /Volumes) return 0 ;;
    # A NAS volume's top and its system shares; a new folder beside them (/volume1/rendezvous-gateway) is fine.
    /volume[0-9]* | /volumeUSB*)
      case $1 in
        */*/*/*) return 1 ;;
        /*/docker | /*/homes | /*/@* | /*/web | /*/photo | /*/music | /*/video | /*/public | /*/NetBackup) return 0 ;;
        /*/*) return 1 ;;
      esac
      return 0 ;;
  esac
  case "${HOME%/}/" in "${1%/}/"*) return 0 ;; esac
  case $1 in /*/*) return 1 ;; *) return 0 ;; esac
}

# "~/x" and relative paths become absolute.
abs_path() {
  p=$1
  # shellcheck disable=SC2088  # a literal "~/" typed at the prompt, expanded here
  case $p in
    '~') p=$HOME ;;
    '~/'*) p="$HOME/${p#'~/'}" ;;
  esac
  case $p in
    /*) ;;
    *) here=$(pwd); p="${here%/}/$p" ;;
  esac
  while :; do
    case $p in
      */) [ "$p" = / ] && break; p=${p%/} ;;
      *) break ;;
    esac
  done
  printf '%s' "$p"
}

# Strip one trailing slash from a URL.
trim_url() {
  u=$1
  case $u in */) u=${u%/} ;; esac
  printf '%s' "$u"
}

# The client-IP header each tunnel sets (and a client cannot forge past it).
header_for() {
  case $1 in
    cloudflare-token | cloudflare-quick) printf 'cf-connecting-ip' ;;
    tailscale) printf 'x-forwarded-for' ;;
    *) printf '' ;;
  esac
}

# The first .trycloudflare.com address in some log text, or nothing.
quick_url_from() {
  printf '%s\n' "$1" | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n 1 || true
}

# --- questions (one at a time, from the terminal) ----------------------------

tty_ok() { [ "${RDV_GW_NO_TTY:-0}" != 1 ] && (: </dev/tty) 2>/dev/null; }

# ask <flag> <question> <default>: sets ANSWER. Without a terminal, the default
# is taken only with --yes or --dry-run; otherwise the flag is required.
ask() {
  if [ -n "$3" ] && [ "$YES" = 1 ]; then
    ANSWER=$3
    say "$2 [$3]: (default)"
    return 0
  fi
  if tty_ok; then
    if [ -n "$3" ]; then printf '%s [%s]: ' "$2" "$3" >/dev/tty; else printf '%s: ' "$2" >/dev/tty; fi
    IFS= read -r ANSWER </dev/tty || ANSWER=
    [ -n "$ANSWER" ] || ANSWER=$3
    return 0
  fi
  if [ -n "$3" ] && [ "$DRY_RUN" = 1 ]; then
    ANSWER=$3
    say "$2 [$3]: (default)"
    return 0
  fi
  die "no terminal to ask \"$2\". Run this from your own terminal, or pass $1"
}

# ask_yn <flag> <question> y|n: returns 0 for yes.
ask_yn() {
  while :; do
    if [ "$3" = y ]; then ask "$1" "$2 (y/n)" y; else ask "$1" "$2 (y/n)" n; fi
    case $ANSWER in
      y | Y | yes | YES | Yes) return 0 ;;
      n | N | no | NO | No) return 1 ;;
      *) say 'Please answer y or n.' ;;
    esac
  done
}

# A secret from the terminal, never echoed, into SECRET.
read_secret() {
  tty_ok || die "no terminal to ask for $1. Run this from your own terminal"
  printf '%s (nothing is shown as you type): ' "$1" >/dev/tty
  old=$(stty -g </dev/tty)
  trap 'stty "$old" </dev/tty 2>/dev/null; exit 130' INT TERM
  stty -echo </dev/tty
  IFS= read -r SECRET </dev/tty || SECRET=
  stty "$old" </dev/tty
  trap - INT TERM
  printf '\n' >/dev/tty
}

# --- prerequisites -----------------------------------------------------------

pkg_hint() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) printf 'brew install %s' "$1" ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then printf 'sudo apt-get install %s' "$1"
      elif command -v dnf >/dev/null 2>&1; then printf 'sudo dnf install %s' "$1"
      elif command -v pacman >/dev/null 2>&1; then printf 'sudo pacman -S %s' "$1"
      elif command -v apk >/dev/null 2>&1; then printf 'sudo apk add %s' "$1"
      else printf 'your package manager (package "%s")' "$1"; fi ;;
    *) printf 'your package manager (package "%s")' "$1" ;;
  esac
}

# Which compose to call: the plugin ("docker compose") or a standalone v2 docker-compose (Synology).
detect_compose() {
  COMPOSE=
  if docker compose version >/dev/null 2>&1; then COMPOSE=plugin
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version 2>/dev/null | grep -Eq 'v?2\.'; then COMPOSE=standalone
  fi
}
compose() {
  if [ "$COMPOSE" = standalone ]; then docker-compose --project-directory "$D" -f "$D/docker-compose.yml" "$@"
  else docker compose --project-directory "$D" -f "$D/docker-compose.yml" "$@"; fi
}

# Sets DOCKER_MISSING to what Docker lacks here ("" when ready).
check_docker() {
  DOCKER_MISSING=
  if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
    DOCKER_MISSING='Docker on macOS cannot share the host network the gateway needs; use --runtime node'
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    DOCKER_MISSING='docker is not installed (https://docs.docker.com/engine/install/)'
    return
  fi
  detect_compose
  if [ -z "$COMPOSE" ]; then
    DOCKER_MISSING='the Docker Compose v2 plugin is missing (https://docs.docker.com/compose/install/linux/)'
    return
  fi
  if ! err=$(docker info 2>&1 >/dev/null); then
    case $err in
      *ermission*) DOCKER_MISSING="your user cannot use Docker. Add it to the docker group (then log in again), or on a NAS where only root can, run this with sudo and --allow-root" ;;
      *) DOCKER_MISSING='the Docker daemon is not running (start Docker, then run this again)' ;;
    esac
  fi
}

# Sets NODE_MISSING to what the Node runtime lacks here ("" when ready).
check_node() {
  NODE_MISSING=
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    NODE_MISSING='Node.js 20 or newer with npm (https://nodejs.org)'
    return
  fi
  v=$(node -p 'process.versions.node' 2>/dev/null || printf 0)
  major=${v%%.*}
  case $major in '' | *[!0-9]*) major=0 ;; esac
  if [ "$major" -lt 20 ]; then NODE_MISSING="Node.js 20 or newer (found v$v; https://nodejs.org)"; return; fi
  case "$(uname -s 2>/dev/null)" in
    Darwin) command -v launchctl >/dev/null 2>&1 || NODE_MISSING='launchctl (macOS service manager)' ;;
    Linux) systemctl --user show-environment >/dev/null 2>&1 || NODE_MISSING='a systemd user session (systemctl --user); use Docker instead' ;;
    *) NODE_MISSING="a supported service manager (systemd or launchd) on $(uname -s 2>/dev/null)" ;;
  esac
}

# --- saved settings ----------------------------------------------------------

# install.conf holds only the non-secret answers, as KEY=value lines we parse (never source).
load_conf() {
  CONF_FOUND=0
  [ -f "$D/install.conf" ] || return 0
  CONF_FOUND=1
  while IFS='=' read -r k v; do
    case $k in
      RUNTIME) C_RUNTIME=$v ;;
      REF) C_REF=$v ;;
      PORT) C_PORT=$v ;;
      TUNNEL) C_TUNNEL=$v ;;
      PUBLIC_URL) C_PUBLIC_URL=$v ;;
      CLIENT_IP_HEADER) C_HEADER=$v ;;
    esac
  done <"$D/install.conf"
}

save_conf() {
  write_file "$D/install.conf" 600 <<EOF
# Written by install-gateway.sh: your answers, so a re-run (./gw update) keeps them. No secrets here.
RUNTIME=$RUNTIME
REF=$REF
PORT=$PORT
TUNNEL=$TUNNEL
PUBLIC_URL=$PUBLIC_URL
CLIENT_IP_HEADER=$CLIENT_IP_HEADER
EOF
}

# --- the generated files -----------------------------------------------------

write_env() {
  write_file "$D/.env" 600 <<EOF
# Read by docker compose (the project is named after this folder). No secrets here (a tunnel token lives in cloudflared.token).
NODE_IMAGE=$NODE_IMAGE
CLOUDFLARED_IMAGE=$CLOUDFLARED_IMAGE
RDV_UID=$RDV_UID
RDV_GID=$RDV_GID
TUNNEL_UID=$(id -u)
TUNNEL_GID=$(id -g)
GW_PORT=$PORT
GW_PUBLIC_URL=$PUBLIC_URL
GW_CLIENT_IP_HEADER=$CLIENT_IP_HEADER
EOF
}

compose_tunnel_service() {
  # shellcheck disable=SC2016  # ${GW_PORT} is for compose to fill in
  # The token reaches cloudflared as a read-only file (--token-file), never as an environment variable, so neither
  # docker inspect nor docker compose config shows it. The container runs as the token file's owner (you; root on a
  # NAS, without any capability), the only user that can read it.
  case $TUNNEL in
    cloudflare-token) cmd='["tunnel", "--no-autoupdate", "run", "--token-file", "/etc/cloudflared/cloudflared.token"]'; vol='    volumes:
      - ./cloudflared.token:/etc/cloudflared/cloudflared.token:ro
' ;;
    cloudflare-quick) cmd='["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:${GW_PORT}"]'; vol='' ;;
    *) return 0 ;;
  esac
  cat <<EOF
  tunnel:
    image: \${CLOUDFLARED_IMAGE}
    command: $cmd
    user: "\${TUNNEL_UID}:\${TUNNEL_GID}"
$vol    environment:
      - HOME=/tmp
    network_mode: host
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    mem_limit: 256m
    restart: unless-stopped
EOF
}

write_compose() {
  {
    cat <<'EOF'
# Written by install-gateway.sh; a re-run rewrites it. Settings are in .env.
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
    network_mode: host          # listens on 127.0.0.1 only; the tunnel or proxy on this host reaches it there
    user: "${RDV_UID}:${RDV_GID}"
    environment:
      - HOME=/tmp
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    mem_limit: 512m
    restart: unless-stopped
    volumes:
      - ./repo:/app:ro
      - ./data:/data            # the agent's home: key, contacts, PIN hash, tokens
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:${GW_PORT}/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
EOF
    compose_tunnel_service
  } | write_file "$D/docker-compose.yml" 644
}

write_ctl() {
  # As root (a NAS), ./gw update runs as root again, for the same gateway user.
  ROOT_FLAGS=''
  [ "$(id -u)" != 0 ] || ROOT_FLAGS="--allow-root --uid $RDV_UID "
  # ./gw update runs the installer copy only while it and the folder are yours alone (no symlink, group or other
  # write, or ACL), the same check the installer makes before every write.
  # shellcheck disable=SC2016  # written into ./gw as is
  MINE_FUNC='mine() {
  [ ! -L "$1" ] || return 1
  m=$(ls -lnd "$1" 2>/dev/null) || return 1
  [ "$(printf "%s" "$m" | awk "{print \$3}")" = "$(id -u)" ] || return 1
  case ${m%% *} in ?????w* | ????????w* | *+) return 1 ;; esac
}'
  if [ "$RUNTIME" = docker ]; then
    write_file "$D/gw" 755 <<EOF
#!/bin/sh
# Control the Rendezvous gateway in this folder (written by install-gateway.sh).
#   ./gw status | logs [tunnel] | start | stop | restart | update | uninstall
#   ./gw rdv <command...>        the rdv CLI on the gateway's agent (e.g. ./gw rdv whoami)
#   ./gw backup <file>           an encrypted backup of the agent (you type a new passphrase)
#   ./gw pin|token|oauth|agent ...  rdv-gateway's owner commands, in your own terminal (agent add: then ./gw restart)
set -eu
DIR=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
$MINE_FUNC
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose --project-directory "\$DIR" -f "\$DIR/docker-compose.yml" "\$@"
  else docker-compose --project-directory "\$DIR" -f "\$DIR/docker-compose.yml" "\$@"; fi
}
cmd=\${1:-help}
[ \$# -gt 0 ] && shift
case \$cmd in
  status) compose ps; printf 'local health: '; wget -q -O - "http://127.0.0.1:$PORT/healthz" 2>/dev/null || curl -fsS "http://127.0.0.1:$PORT/healthz" || printf 'not answering'; printf '\n' ;;
  logs) compose logs -f --tail 100 "\${1:-gateway}" ;;
  start) compose up -d ;;
  stop) compose stop ;;
  restart) compose restart ;;
  update) mine "\$DIR" && mine "\$DIR/install-gateway.sh" || { echo "gw: \$DIR or its installer copy is not yours alone (owner, symlink, group or other write, or an ACL); not running it" >&2; exit 1; }
    exec sh "\$DIR/install-gateway.sh" --dir "\$DIR" --update $ROOT_FLAGS"\$@" ;;
  rdv) exec compose run --rm --no-deps gateway node packages/cli/dist/src/bin.js "\$@" --home /data ;;
  pin | token | oauth | agent) exec compose run --rm --no-deps gateway node packages/gateway/dist/src/bin.js "\$cmd" "\$@" --home /data ;;
  backup)
    [ \$# -eq 1 ] || { echo 'usage: ./gw backup <file>' >&2; exit 2; }
    out=\$(CDPATH= cd -- "\$(dirname -- "\$1")" && pwd)
    exec compose run --rm --no-deps -v "\$out:/out" gateway node packages/cli/dist/src/bin.js backup "/out/\$(basename -- "\$1")" --home /data ;;
  uninstall)
    compose down --remove-orphans
    $UNINSTALL_EXTRA
    printf 'Stopped and removed the containers. Your agent is still in %s/data.\n' "\$DIR"
    printf 'To delete everything, including the agent key (back it up first: ./gw backup <file>), run: rm -rf %s\n' "\$DIR" ;;
  *) sed -n '2,6p' "\$0" ;;
esac
EOF
  else
    write_file "$D/gw" 755 <<EOF
#!/bin/sh
# Control the Rendezvous gateway in this folder (written by install-gateway.sh).
#   ./gw status | logs [tunnel] | start | stop | restart | update | uninstall
#   ./gw rdv <command...>        the rdv CLI on the gateway's agent (e.g. ./gw rdv whoami)
#   ./gw backup <file>           an encrypted backup of the agent (you type a new passphrase)
#   ./gw pin|token|oauth|agent ...  rdv-gateway's owner commands, in your own terminal (agent add: then ./gw restart)
set -eu
DIR=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
$MINE_FUNC
NODE='$NODE_BIN'
cmd=\${1:-help}
[ \$# -gt 0 ] && shift
$SERVICE_FUNCS
case \$cmd in
  status) svc_status; printf 'local health: '; curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null || wget -q -O - "http://127.0.0.1:$PORT/healthz" 2>/dev/null || printf 'not answering'; printf '\n' ;;
  logs) svc_logs "\${1:-gateway}" ;;
  start) svc_start ;;
  stop) svc_stop ;;
  restart) svc_stop; svc_start ;;
  update) mine "\$DIR" && mine "\$DIR/install-gateway.sh" || { echo "gw: \$DIR or its installer copy is not yours alone (owner, symlink, group or other write, or an ACL); not running it" >&2; exit 1; }
    exec sh "\$DIR/install-gateway.sh" --dir "\$DIR" --update "\$@" ;;
  rdv) exec "\$NODE" "\$DIR/repo/impl/packages/cli/dist/src/bin.js" "\$@" --home "\$DIR/data" ;;
  pin | token | oauth | agent) exec "\$NODE" "\$DIR/repo/impl/packages/gateway/dist/src/bin.js" "\$cmd" "\$@" --home "\$DIR/data" ;;
  backup) exec "\$NODE" "\$DIR/repo/impl/packages/cli/dist/src/bin.js" backup "\$@" --home "\$DIR/data" ;;
  uninstall)
    svc_remove
    $UNINSTALL_EXTRA
    printf 'Stopped and removed the service. Your agent is still in %s/data.\n' "\$DIR"
    printf 'To delete everything, including the agent key (back it up first: ./gw backup <file>), run: rm -rf %s\n' "\$DIR" ;;
  *) sed -n '2,6p' "\$0" ;;
esac
EOF
  fi
}

# --- node runtime: user services ---------------------------------------------

gateway_args() {
  printf '%s' "$DIR/repo/impl/packages/gateway/dist/src/bin.js serve --home $DIR/data --host 127.0.0.1 --port $PORT --public-url $PUBLIC_URL --client-ip-header $CLIENT_IP_HEADER"
}
tunnel_args() {
  case $TUNNEL in
    cloudflare-token) printf 'tunnel --no-autoupdate run --token-file %s/cloudflared.token' "$DIR" ;;
    cloudflare-quick) printf 'tunnel --no-autoupdate --url http://127.0.0.1:%s' "$PORT" ;;
  esac
}
has_tunnel_service() { case $TUNNEL in cloudflare-*) return 0 ;; *) return 1 ;; esac; }

UNIT_DIR="${XDG_CONFIG_HOME:-${HOME:-}/.config}/systemd/user"
AGENTS_DIR="${HOME:-}/Library/LaunchAgents"

write_systemd_units() {
  write_file "$UNIT_DIR/rdv-gateway.service" 644 <<EOF
# Written by install-gateway.sh ($DIR).
[Unit]
Description=Rendezvous gateway
After=network-online.target

[Service]
ExecStart=$NODE_BIN $(gateway_args)
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  if has_tunnel_service; then
    write_file "$UNIT_DIR/rdv-gateway-tunnel.service" 644 <<EOF
# Written by install-gateway.sh ($DIR).
[Unit]
Description=Rendezvous gateway tunnel (cloudflared)
After=network-online.target

[Service]
ExecStart=$CLOUDFLARED_BIN $(tunnel_args)
StandardError=append:$DIR/logs/cloudflared.log
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
  fi
}

plist() { # plist <label> <log> <program args...>
  label=$1 log=$2
  shift 2
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  printf '<plist version="1.0"><dict>\n  <key>Label</key><string>%s</string>\n  <key>ProgramArguments</key><array>\n' "$label"
  for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done
  printf '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>Umask</key><integer>63</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n</dict></plist>\n' "$log" "$log"
}

write_launchd_agents() {
  # shellcheck disable=SC2046  # gateway_args is validated: no spaces inside its words
  plist co.nesher.rdv-gateway "$DIR/logs/gateway.log" "$NODE_BIN" $(gateway_args) | write_file "$AGENTS_DIR/co.nesher.rdv-gateway.plist" 644
  if has_tunnel_service; then
    # The token reaches cloudflared from the 600 token file (--token-file), never from this plist.
    # shellcheck disable=SC2046
    plist co.nesher.rdv-gateway-tunnel "$DIR/logs/cloudflared.log" "$CLOUDFLARED_BIN" $(tunnel_args) |
      write_file "$AGENTS_DIR/co.nesher.rdv-gateway-tunnel.plist" 644
  fi
}

service_funcs() {
  if [ "$(uname -s)" = Darwin ]; then
    cat <<'EOF'
D="gui/$(id -u)"
svc_status() { launchctl print "$D/co.nesher.rdv-gateway" 2>/dev/null | grep -E '^\s*state' || printf 'not loaded\n'; }
svc_logs() { if [ "$1" = tunnel ]; then tail -n 100 -f "$DIR/logs/cloudflared.log"; else tail -n 100 -f "$DIR/logs/gateway.log"; fi; }
svc_start() { for p in "$HOME"/Library/LaunchAgents/co.nesher.rdv-gateway*.plist; do [ -f "$p" ] && launchctl bootstrap "$D" "$p" 2>/dev/null || true; done; }
svc_stop() { for l in co.nesher.rdv-gateway-tunnel co.nesher.rdv-gateway; do launchctl bootout "$D/$l" 2>/dev/null || true; done; }
svc_remove() { svc_stop; rm -f "$HOME"/Library/LaunchAgents/co.nesher.rdv-gateway.plist "$HOME"/Library/LaunchAgents/co.nesher.rdv-gateway-tunnel.plist; }
EOF
  else
    cat <<'EOF'
U="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
units() { for u in rdv-gateway rdv-gateway-tunnel; do [ -f "$U/$u.service" ] && printf '%s ' "$u"; done; }
svc_status() { systemctl --user --no-pager status $(units) || true; }
svc_logs() { if [ "$1" = tunnel ]; then tail -n 100 -f "$DIR/logs/cloudflared.log"; else journalctl --user -u rdv-gateway -f -n 100; fi; }
svc_start() { systemctl --user start $(units); }
svc_stop() { systemctl --user stop $(units); }
svc_remove() { systemctl --user disable --now $(units) || true; rm -f "$U/rdv-gateway.service" "$U/rdv-gateway-tunnel.service"; systemctl --user daemon-reload; }
EOF
  fi
}

# --- running rdv and rdv-gateway against the gateway's home ------------------

CLI_JS=packages/cli/dist/src/bin.js
GW_JS=packages/gateway/dist/src/bin.js

# tool <run|run_tty> <rdv|gw> <args...>
tool() {
  how=$1 which=$2
  shift 2
  if [ "$which" = rdv ]; then js=$CLI_JS; else js=$GW_JS; fi
  if [ "$RUNTIME" = docker ]; then
    if [ "$how" = run ]; then "$how" compose run --rm --no-deps -T gateway node "$js" "$@" --home /data
    else "$how" compose run --rm --no-deps gateway node "$js" "$@" --home /data; fi
  else
    "$how" "$NODE_BIN" "$D/repo/impl/$js" "$@" --home "$D/data"
  fi
}

http_ok() {
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 -o /dev/null "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null "$1" 2>/dev/null
  elif [ "$RUNTIME" = docker ]; then compose exec -T gateway wget -q -T 5 -O /dev/null "$1" 2>/dev/null
  else "$NODE_BIN" -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "$1"
  fi
}

# --- the steps -----------------------------------------------------------------

# As root (a NAS where only root can use Docker): which normal user the gateway runs as. The one who ran sudo by
# default, never a fixed id, and confirmed. Only data/ becomes theirs; the code stays root's.
choose_uid() {
  uid=${UID_FLAG:-${SUDO_UID:-}}
  if [ -z "$uid" ]; then
    say 'You run this as root. The gateway must run as a normal user, who will own only data/ (the agent).'
    ask --uid 'That user id (see: id -u <name>)' ''
    uid=$ANSWER
  fi
  matches '^[0-9]{1,10}$' "$uid" && [ "$uid" != 0 ] || die "--uid is a normal user's id, not 0 (got: $uid)"
  gid=${SUDO_GID:-}
  [ -n "$UID_FLAG" ] && gid=''
  if [ -z "$gid" ]; then
    gid=$(getent passwd "$uid" 2>/dev/null | cut -d: -f4)
    [ -n "$gid" ] || gid=$uid
  fi
  name=$(getent passwd "$uid" 2>/dev/null | cut -d: -f1)
  ask_yn --uid "Run the gateway as uid $uid${name:+ ($name)}, gid $gid?" y || die 'pass the right one with --uid'
  RDV_UID=$uid RDV_GID=$gid
  say "repo/, the installer and ./gw stay root's; only data/ belongs to uid $uid. If your user can use Docker (the docker group, or rootless Docker), run this without sudo instead."
}

choose_runtime() {
  step 2 'choose the runtime'
  check_docker
  check_node
  if [ -n "$DOCKER_MISSING" ]; then say "Docker: not ready: $DOCKER_MISSING"; else say 'Docker: ready'; fi
  if [ -n "$NODE_MISSING" ]; then say "Node.js: not ready: $NODE_MISSING"; else say "Node.js: ready ($(node --version))"; fi
  if [ -z "$RUNTIME" ]; then
    if [ -z "$DOCKER_MISSING" ] && [ -z "$NODE_MISSING" ]; then
      say 'Both can run the gateway. Docker keeps it in a locked-down container (recommended); Node.js runs it as a service of your user.'
      while :; do
        ask --runtime 'Runtime: docker or node' "${C_RUNTIME:-docker}"
        case $ANSWER in docker | node) RUNTIME=$ANSWER; break ;; *) say 'Type docker or node.' ;; esac
      done
    elif [ -z "$DOCKER_MISSING" ]; then RUNTIME=docker
    elif [ -z "$NODE_MISSING" ]; then RUNTIME=node
    elif [ "$DRY_RUN" = 1 ]; then RUNTIME=docker; warn 'nothing can run the gateway here yet (dry run goes on with docker)'
    else die "nothing here can run the gateway yet. Fix one of: Docker: $DOCKER_MISSING; or Node.js: $NODE_MISSING"
    fi
  fi
  case $RUNTIME in
    docker) [ -z "$DOCKER_MISSING" ] || [ "$DRY_RUN" = 1 ] || die "Docker is not ready: $DOCKER_MISSING" ;;
    node)
      [ -z "$NODE_MISSING" ] || [ "$DRY_RUN" = 1 ] || die "Node.js is not ready: $NODE_MISSING"
      [ "$(id -u)" != 0 ] || die 'the Node.js runtime runs as your own user: do not use root for it'
      ;;
    *) die "--runtime is docker or node (got: $RUNTIME)" ;;
  esac
  [ -n "$COMPOSE" ] || COMPOSE=plugin
  [ "$(id -u)" != 0 ] || choose_uid
  NODE_BIN=$(command -v node 2>/dev/null || printf '/usr/bin/node')
  if [ "$RUNTIME" = node ] && ! valid_path "$NODE_BIN" && [ "$DRY_RUN" != 1 ]; then
    die "node is at $NODE_BIN; a service cannot start a path with spaces or special characters. Use Docker, or a Node.js installed elsewhere"
  fi
  say "Runtime: $RUNTIME"
  done_step 2
}

# The install folder, before anything is written there: not a system or shared folder, not a folder with other
# things in it (it is made private and its files replaced), not a symlink, and it and the folder it is in belong to
# you (or, for the folder it is in, to root) and are not writable by others.
check_install_dir() {
  ! system_dir "$1" || die "$1 is a system or shared folder; choose a folder of its own, such as $HOME/rendezvous-gateway"
  if [ -e "$1" ] || [ -L "$1" ]; then
    [ ! -L "$1" ] || die "$1 is a symbolic link; give the real folder"
    [ -d "$1" ] || die "$1 exists and is not a folder"
    if [ ! -f "$1/install.conf" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
      die "$1 already has other files in it and no gateway install. Choose a new or empty folder (this one would be made private and its files replaced)"
    fi
    check_private "$1"
  fi
  # Every folder above it, up to /: yours or root's, and no one else may rename entries in it. Whoever can rename an
  # entry in any of them can swap the whole install between runs: Docker resolves the bind paths again at every
  # container start, and a later `sudo ./gw update` would run their ./gw as root. So a shared parent is refused, not
  # warned about: group or other write without the sticky bit, or an ACL letting anyone else write or delete. That
  # rules out a Synology share such as /volume1/docker (its ACL lets user:anon write); use /volume1/rendezvous-gateway.
  up=$(dirname "$1")
  case $up in /tmp | /var/tmp | /dev/shm | /private/tmp) die "$up is a temporary folder; put the gateway in a folder that is yours" ;; esac
  # A folder still to be made under a sticky folder anyone can write (/tmp-like) could be made first by someone else.
  below_missing=0
  [ -e "$1" ] || [ -L "$1" ] || below_missing=1
  while :; do
    if [ -e "$up" ] || [ -L "$up" ]; then
      [ ! -L "$up" ] || die "$up is a symbolic link; give the real path"
      if [ "$below_missing" = 1 ] && sticky "$up" && others_can_write "$up"; then
        die "$up is a shared sticky folder (like /tmp): someone else could create the folders below it first; put the gateway in a folder that is yours"
      fi
      below_missing=0
      o=$(owner_of "$up")
      [ "$o" = "$(id -u)" ] || [ "$o" = 0 ] || die "$up belongs to uid $o, so it could swap the install; put the gateway under folders that are yours or root's"
      if others_can_write "$up" && ! sticky "$up"; then
        die "$up can be written by other users, who could swap the install; put the gateway under folders only you or root can change$(nas_hint)"
      fi
      if acl_lets_others_write "$up"; then
        die "$up has an ACL that lets other users write or delete in it, so they could swap the install; put the gateway under folders without one$(nas_hint)"
      fi
    else
      below_missing=1
    fi
    [ "$up" != / ] || break
    up=$(dirname "$up")
  done
}
# On a Synology NAS, where to put it instead of a share.
nas_hint() { if is_dsm; then printf ' (on a Synology NAS: --dir /volume1/rendezvous-gateway, outside the shares; only root can create it, so run the installer with sudo and --allow-root. Your DSM home is in the homes share, which other accounts can write, so it is refused too)'; fi; }
is_dsm() { [ -f /etc/synoinfo.conf ] || [ -x /usr/syno/bin/synoacltool ]; }
have_getfacl() { command -v getfacl >/dev/null 2>&1; }
# The sticky bit (t or T in the last mode character): others may add entries but not rename or delete yours.
sticky() { case $(mode_of "$1") in ?????????[tT]*) return 0 ;; esac; return 1; }
# Does an ACL let a principal other than root or you write, append, delete, change the ACL or take ownership?
# DSM's synoacltool, or getfacl. It fails closed: a tool that fails, output with no entry we can read, a format we do
# not recognise, or a + in ls with no tool that shows the entries, all count as yes.
acl_lets_others_write() {
  has_acl "$1" || return 1
  me=$(id -un 2>/dev/null)
  if t=$(syno_acl_tool); then
    out=$("$t" -get "$1" 2>/dev/null) || return 0
    # Lines like: [2] group:NAS\Domain Users:allow:rwxpdDaARWc--:fd-- (level:0). Names may hold spaces and colons
    # come last-but-two, so allow, perm and inheritance are read from the end.
    printf '%s\n' "$out" | awk -v me="$me" '
      /^[ \t]*\[[0-9]+\]/ {
        line = $0
        sub(/^[ \t]*\[[0-9]+\][ \t]*/, "", line)
        sub(/[ \t]*\(level:[0-9]+\)[ \t]*$/, "", line)
        n = split(line, f, ":")
        if (n < 5) { bad = 1; next }
        allow = f[n - 2]; perm = f[n - 1]; kind = f[1]
        name = f[2]; for (i = 3; i <= n - 3; i++) name = name ":" f[i]
        parsed++
        if (perm !~ /^[-rwxpdDaARWcCo]+$/ || length(perm) != 13) { bad = 1; next }
        if (allow == "deny") next
        if (allow != "allow") { bad = 1; next }
        if ((kind == "user" && (name == "root" || name == me)) || kind == "owner") next
        if (perm ~ /[wpdDCo]/) bad = 1
      }
      END { if (!parsed) exit 0; exit bad ? 0 : 1 }'
    return
  fi
  if have_getfacl; then
    out=$(getfacl -cp "$1" 2>/dev/null) || return 0
    # A POSIX ACL behind a + always has a named entry or a mask; with only user::, group:: and other:: shown the
    # real ACL is something getfacl cannot show (NFSv4, a FreeBSD getfacl without -c/-p).
    printf '%s\n' "$out" | awk -F: -v me="$me" '
      /^[ \t]*(#|$)/ { next }
      $0 !~ /^(default:)?(user|group|mask|other):[^:]*:[-rwx][-rwx][-rwx]([ \t]|#|$)/ { bad = 1; next }
      { k = $1; nm = $2; p = $3; if (k == "default") { k = $2; nm = $3; p = $4 } }
      k == "mask" || ((k == "user" || k == "group") && nm != "") { full = 1 }
      (k == "user" || k == "group") && nm != "" && !(k == "user" && (nm == "root" || nm == me)) && p ~ /w/ { bad = 1 }
      END { if (!full) exit 0; exit bad ? 0 : 1 }'
    return
  fi
  return 0
}

# The first column of ls -ld (type, mode and a trailing + or @ for an ACL or extended attributes), and the numeric
# owner and group: what every system's ls shows.
# shellcheck disable=SC2012  # only the columns of one validated path are read
mode_of() { ls -lnd "$1" 2>/dev/null | awk '{print $1}'; }
# shellcheck disable=SC2012
group_of() { ls -lnd "$1" 2>/dev/null | awk '{print $4}'; }
# Writable by anyone but its owner? Group write is fine only when the group is the owner's private group (a user
# private group home: group named like the user, with the user's own gid).
# Your private group has no other members (getent group lists none); without getent it is not assumed.
upg_alone() {
  g=$(getent group "$(id -g)" 2>/dev/null) || return 1
  [ -n "$g" ] || return 1
  members=${g##*:}
  [ -z "$members" ] || [ "$members" = "$(id -un 2>/dev/null)" ]
}
others_can_write() {
  m=$(mode_of "$1")
  case $m in ????????w*) return 0 ;; esac
  case $m in
    ?????w*)
      [ "$(group_of "$1")" = "$(id -g)" ] && [ "$(id -gn 2>/dev/null)" = "$(id -un 2>/dev/null)" ] && [ "$(owner_of "$1")" = "$(id -u)" ] && upg_alone && return 1
      return 0 ;;
  esac
  return 1
}
# Synology DSM's ACL tool, when there is one.
syno_acl_tool() {
  for t in synoacltool /usr/syno/bin/synoacltool; do
    if command -v "$t" >/dev/null 2>&1; then command -v "$t"; return 0; fi
  done
  return 1
}
# Does a path carry an ACL? A trailing + in ls -ld (POSIX ACLs, DSM), or entries in synoacltool -get.
has_acl() {
  case $(mode_of "$1") in *+) return 0 ;; esac
  t=$(syno_acl_tool) || return 1
  "$t" -get "$1" 2>/dev/null | grep -Eq '^[[:space:]]*\[[0-9]+\]'
}
# The install folder must be yours, not a symlink, not writable by anyone else, and without an ACL.
check_private() {
  [ ! -L "$1" ] || die "$1 is a symbolic link; this installer will not use it"
  check_owned "$1"
  ! others_can_write "$1" || die "$1 can be written by other users; fix its permissions (chmod 700) or choose another folder"
  ! has_acl "$1" || die "$1 has an ACL (other users may reach it). Remove it (Synology: synoacltool -del $1) or choose another folder"
}
# Make the install folder (700, no ACL) and check it. On DSM a new folder can inherit the share's ACL: strip it.
make_install_dir() {
  [ "$DRY_RUN" != 1 ] || return 0
  if [ ! -d "$DIR" ]; then
    (umask 077 && mkdir -p "$DIR") || die "cannot create $DIR (a folder in a root-owned place such as /volume1 needs sudo and --allow-root)"
  fi
  chmod 700 "$DIR" || die "cannot chmod $DIR"
  if t=$(syno_acl_tool) && has_acl "$DIR"; then
    "$t" -del "$DIR" >/dev/null 2>&1 || die "cannot remove the ACL $DIR inherited ($t -del $DIR)"
  fi
  check_private "$DIR"
}
# Before every write into the install folder and every run of something in it: still private (nothing swapped it
# for a symlink, changed its owner or gave it an ACL meanwhile).
recheck_dir() {
  [ "$DRY_RUN" != 1 ] && [ -n "${DIR:-}" ] || return 0
  if [ "${D:-}" = . ]; then
    # We work from inside the folder by relative paths, so a rename of its parent's entry cannot redirect a write
    # or a command. Still: the folder we are in must be the one we checked, at the path we checked, and private.
    now=$(real_cwd)
    [ "$now" = "$DIR" ] || die "the install folder moved while the installer ran (now $now); stopping"
    check_private .
  elif [ -e "$DIR" ]; then
    check_private "$DIR"
  fi
}
# Step into the install folder once it is checked: from here on every write and every command uses paths relative
# to it (D=.), and docker gets its real path at the moment it is needed (here).
enter_install_dir() {
  [ "$DRY_RUN" != 1 ] || return 0
  cd -P -- "$DIR" || die "cannot enter $DIR"
  now=$(real_cwd)
  [ "$now" = "$DIR" ] || die "$DIR is not where it was checked (now $now); stopping"
  check_private .
  D=.
}
# Where we really are now. Not the shell's own pwd -P: dash answers it from what it remembered at cd, so a folder
# renamed under us would still show its old path. The pwd program asks the kernel.
real_cwd() { env pwd -P 2>/dev/null || die 'cannot run the pwd program (env pwd -P) to check where the installer is'; }
here() { if [ "${D:-}" = . ]; then real_cwd; else printf '%s' "$DIR"; fi; }

choose_dir_and_settings() {
  step 1 'choose the folder'
  if [ -z "$DIR" ]; then
    # On a Synology NAS, beside the shares, not in one: /volume1 is root's 755 there, while a share such as
    # /volume1/docker carries an ACL that lets other accounts (even anon) write, which could swap the install.
    def="$HOME/rendezvous-gateway"
    # Only root can create a folder in /volume1 (and a DSM home lives in the homes share, which is refused), so on
    # DSM this is the default either way; without sudo, creating it fails with a message that says so.
    if is_dsm && [ -d /volume1 ]; then def=/volume1/rendezvous-gateway; fi
    ask --dir 'Install folder' "$def"
    DIR=$ANSWER
  fi
  DIR=$(abs_path "$DIR")
  valid_path "$DIR" || die "use a folder path without spaces or special characters (got: $DIR)"
  # Judge the real path: the part that exists, with symlinks resolved.
  DIR=$(physical_path "$DIR")
  valid_path "$DIR" || die "the folder resolves to a path with special characters: $DIR"
  check_install_dir "$DIR"
  make_install_dir
  # Again, now that every folder on the path exists (the first walk could only judge the ones that did).
  [ "$DRY_RUN" = 1 ] || check_install_dir "$DIR"
  D=$DIR
  enter_install_dir
  load_conf
  if [ "$CONF_FOUND" = 1 ]; then
    say "Found a gateway installed here (runtime ${C_RUNTIME:-?}, ${C_TUNNEL:-?}, ${C_PUBLIC_URL:-?}, code: ${REF:-${C_REF:-main}})."
    if [ "$UPDATE" != 1 ] && ask_yn --update "Update it to ${REF:-${C_REF:-main}} and keep these settings?" y; then UPDATE=1; fi
    [ "$UPDATE" != 1 ] || say "Updating to ${REF:-${C_REF:-main}}."
    # Saved answers are the defaults; flags given now win.
    [ -n "$RUNTIME" ] || [ "$UPDATE" != 1 ] || RUNTIME=${C_RUNTIME:-}
    [ -n "$REF" ] || REF=${C_REF:-}
    [ -n "$PORT" ] || PORT=${C_PORT:-}
    if [ "$UPDATE" = 1 ]; then
      [ -n "$TUNNEL" ] || TUNNEL=${C_TUNNEL:-}
      [ -n "$PUBLIC_URL" ] || PUBLIC_URL=${C_PUBLIC_URL:-}
      [ -n "$CLIENT_IP_HEADER" ] || CLIENT_IP_HEADER=${C_HEADER:-}
    fi
  elif [ "$UPDATE" = 1 ]; then
    die "--update needs an existing install in $DIR (install.conf not found)"
  fi
  [ -n "$REF" ] || REF=main
  valid_ref "$REF" || die "--ref is a branch, tag or commit (got: $REF)"
  [ -n "$PORT" ] || PORT=8787
  valid_port "$PORT" || die "--port is a port number (got: $PORT)"
  say "Folder: $DIR (code in repo/, the agent in data/)"
  done_step 1
}

choose_public_address() {
  step 3 'choose how assistants reach it'
  if [ -z "$TUNNEL" ]; then
    say 'The gateway listens only on 127.0.0.1 here. Something must give it a public https address:'
    say '  cloudflare-token  a Cloudflare Tunnel on your own domain (recommended; free Cloudflare account)'
    say '  cloudflare-quick  a quick try-out address (random *.trycloudflare.com, changes on every restart)'
    say '  own-url           your own reverse proxy or domain, already set up on this machine'
    command -v tailscale >/dev/null 2>&1 && say '  tailscale         Tailscale Funnel (https://<machine>.<tailnet>.ts.net)'
    while :; do
      ask --tunnel 'Public address' "${C_TUNNEL:-cloudflare-token}"
      case $ANSWER in cloudflare-token | cloudflare-quick | own-url | tailscale) TUNNEL=$ANSWER; break ;; *) say 'Type one of the names above.' ;; esac
    done
  fi
  case $TUNNEL in cloudflare-token | cloudflare-quick | own-url | tailscale) ;; *) die "--tunnel is cloudflare-token, cloudflare-quick, own-url or tailscale (got: $TUNNEL)" ;; esac

  CLOUDFLARED_BIN=
  if has_tunnel_service && [ "$RUNTIME" = node ]; then
    CLOUDFLARED_BIN=$(command -v cloudflared 2>/dev/null || true)
    [ -n "$CLOUDFLARED_BIN" ] || [ "$DRY_RUN" = 1 ] || die "cloudflared is needed for a Cloudflare tunnel with the Node.js runtime. Install it with: $(pkg_hint cloudflared) (or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run this again"
    [ -n "$CLOUDFLARED_BIN" ] || CLOUDFLARED_BIN=/usr/local/bin/cloudflared
  fi

  case $TUNNEL in
    cloudflare-token)
      if [ -z "$PUBLIC_URL" ]; then
        say 'In the Cloudflare dashboard: Zero Trust, Networks, Tunnels, Create a tunnel (type Cloudflared).'
        say "Give it a public hostname (for example gw.example.com) whose service is HTTP, URL 127.0.0.1:$PORT."
        say 'Then turn off Email Obfuscation for that hostname (Rules, Configuration Rules), so the approval page shows real addresses.'
        ask --public-url 'The public hostname, as an https address (e.g. https://gw.example.com)' ''
        PUBLIC_URL=$ANSWER
      fi
      [ -n "$CLIENT_IP_HEADER" ] || CLIENT_IP_HEADER=cf-connecting-ip
      ;;
    cloudflare-quick)
      warn 'a quick tunnel is for trying it out: its address is random and changes whenever the tunnel restarts (a reboot, an update). Connected assistants then stop working until you connect them again.'
      PUBLIC_URL=${PUBLIC_URL:-}
      [ -n "$CLIENT_IP_HEADER" ] || CLIENT_IP_HEADER=cf-connecting-ip
      ;;
    own-url)
      say "Your proxy must terminate TLS on this machine and forward every path to http://127.0.0.1:$PORT (including /a/<agent>/... and /.well-known/...), with response buffering off."
      if [ -z "$PUBLIC_URL" ]; then
        ask --public-url 'Its public https address (e.g. https://gw.example.com)' ''
        PUBLIC_URL=$ANSWER
      fi
      if [ -z "$CLIENT_IP_HEADER" ]; then
        # No default: a header the proxy does not set is one a client can forge.
        say 'The gateway counts wrong PINs per client, by a header your proxy sets to the real client address. It must be one the proxy always overwrites or appends to (the gateway reads its last value), never one a client sends unchanged:'
        # shellcheck disable=SC2016  # nginx's variable, shown as is
        say '  nginx    x-real-ip, with: proxy_set_header X-Real-IP $remote_addr;'
        say '  Caddy    x-forwarded-for (reverse_proxy sets it; the last value is the client)'
        say '  Traefik  x-forwarded-for (appended; the last value is the client)'
        say '  HAProxy  x-forwarded-for, with: option forwardfor'
        while :; do
          ask --client-ip-header 'Which header does your proxy set' ''
          valid_header "$ANSWER" && break
          say "That is not a header name: $ANSWER"
        done
        CLIENT_IP_HEADER=$ANSWER
      fi
      ;;
    tailscale)
      command -v tailscale >/dev/null 2>&1 || [ "$DRY_RUN" = 1 ] || die 'tailscale is not installed (https://tailscale.com/download)'
      if [ -z "$PUBLIC_URL" ] && command -v tailscale >/dev/null 2>&1; then
        name=$(tailscale status --json 2>/dev/null | grep -o '"DNSName": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/; s/\.$//')
        [ -n "$name" ] || die 'could not read this machine'"'"'s Tailscale name (is it logged in? tailscale up)'
        PUBLIC_URL="https://$name"
      fi
      [ -n "$PUBLIC_URL" ] || PUBLIC_URL=https://machine.tailnet.ts.net
      [ -n "$CLIENT_IP_HEADER" ] || CLIENT_IP_HEADER=x-forwarded-for
      ;;
  esac
  if [ "$TUNNEL" != cloudflare-quick ] || [ -n "$PUBLIC_URL" ]; then
    PUBLIC_URL=$(trim_url "$PUBLIC_URL")
    valid_https_url "$PUBLIC_URL" || die "the public address must be https://host (no path), got: $PUBLIC_URL"
  fi
  valid_header "$CLIENT_IP_HEADER" || die "--client-ip-header is a header name (got: $CLIENT_IP_HEADER)"

  if [ "$TUNNEL" = cloudflare-token ]; then
    if [ -f "$D/cloudflared.token" ] && { [ "$UPDATE" = 1 ] || ask_yn --update 'A tunnel token is saved here. Keep it?' y; }; then
      say 'Keeping the saved tunnel token.'
    elif [ "$DRY_RUN" = 1 ]; then
      say "Would ask for the tunnel token here (never shown) and save it to $DIR/cloudflared.token (mode 600)."
      TOKEN_CHANGED=1
    else
      say 'Paste the tunnel token: in the dashboard it is the long string after --token in the install command.'
      read_secret 'Tunnel token'
      valid_token "$SECRET" || die 'that does not look like a tunnel token (one long string of letters, digits and -_+/=); nothing saved'
      # The folder was checked in step 1 (yours, private, no symlinks); write_file makes a fresh temp file there.
      (umask 077 && mkdir -p "$D") && chmod 700 "$D"
      printf '%s\n' "$SECRET" | write_file "$D/cloudflared.token" 600
      SECRET=
      TOKEN_CHANGED=1
      say "Saved to $DIR/cloudflared.token (mode 600)."
    fi
  fi
  shown=$PUBLIC_URL
  [ -n "$shown" ] || shown='known once the quick tunnel starts'
  say "Public address: $shown; client address header: $CLIENT_IP_HEADER"
  done_step 3
}

# The commit for a branch, a tag, or a commit that one of them contains; fails for anything else.
resolve_ref() {
  if c=$(git -C "$D/repo" rev-parse --verify --quiet "refs/remotes/origin/$1^{commit}"); then printf '%s' "$c"; return 0; fi
  if c=$(git -C "$D/repo" rev-parse --verify --quiet "refs/tags/$1^{commit}"); then printf '%s' "$c"; return 0; fi
  matches '^[0-9a-f]{7,40}$' "$1" || return 1
  c=$(git -C "$D/repo" rev-parse --verify --quiet "$1^{commit}") || return 1
  [ -n "$(git -C "$D/repo" branch -r --contains "$c" 2>/dev/null)$(git -C "$D/repo" tag --contains "$c" 2>/dev/null)" ] || return 1
  printf '%s' "$c"
}

# Who owns a file, as a uid (ls -lnd: the same on GNU, busybox and BSD).
# shellcheck disable=SC2012
owner_of() { o=$(ls -lnd "$1" 2>/dev/null | awk '{print $3}'); printf '%s' "${o:-?}"; }

# The code, the installer copy and the helper must belong to whoever runs this (root on a NAS), never to the
# gateway's own user: ./gw update runs them later, so a tree that user could change would run its code as you.
check_owned() {
  for f in "$@"; do
    [ -e "$f" ] || continue
    o=$(owner_of "$f")
    [ "$o" = "$(id -u)" ] || die "$f belongs to uid $o, not to you (uid $(id -u)). This installer runs only code its own user owns: move it away or fix its owner, then run this again"
  done
}

# The Node.js runtime's build, from the install folder: no cd into repo/, since recheck_dir wants the working
# directory to stay the checked install folder.
build_node() {
  { run npm --prefix "$D/repo/impl" ci --no-audit --no-fund && run npm --prefix "$D/repo/impl" run build; } || die 'the build failed'
}

fetch_and_build() {
  step 4 'get the code and build it'
  check_owned "$D" "$D/repo" "$D/install-gateway.sh" "$D/gw"
  run mkdir -p "$D" "$D/data" "$D/logs"
  run chmod 700 "$D" "$D/data"
  REPO=${RDV_REPO:-https://github.com/omernesh/rendezvous}
  if [ -e "$D/repo/.git" ]; then
    origin=$(git -C "$D/repo" remote get-url origin 2>/dev/null || true)
    [ "$origin" = "$REPO" ] || die "$DIR/repo is a clone of '$origin', not '$REPO'"
    [ -z "$(git -C "$D/repo" status --porcelain 2>/dev/null)" ] || die "$D/repo has local changes; this installer will not overwrite them"
  elif [ -e "$D/repo" ]; then
    die "$DIR/repo exists but is not a git clone. Move it away"
  else
    run git clone --quiet "$REPO" "$D/repo"
  fi
  # Only the published branches and tags, so a commit reachable from neither (a pull request's) is not there to use.
  run git -C "$D/repo" fetch --quiet --prune --tags origin '+refs/heads/*:refs/remotes/origin/*'
  if [ "$DRY_RUN" = 1 ]; then
    show_cmd git -C "$D/repo" checkout --quiet --detach "<$REF: a branch, tag or commit on one of them>"
  else
    commit=$(resolve_ref "$REF") || die "$REF is not a branch, a tag, or a commit on one of them in $REPO"
    git -C "$D/repo" checkout --quiet --detach "$commit" || die "git checkout $commit failed"
    say "Code: $REF at $(git -C "$D/repo" log -1 --format='%h %s')"
  fi
  # ./gw update runs this copy, outside repo/: yours like the rest, never the gateway user's.
  run cp "$D/repo/site/install-gateway.sh" "$D/install-gateway.sh"
  run chmod 755 "$D/install-gateway.sh"
  say 'Building (a few minutes the first time)...'
  if [ "$RUNTIME" = docker ]; then
    # Built as the owner of repo/ (you; root on a NAS, in a container without capabilities), so the gateway's user
    # never owns the code it runs (the gateway mounts it read-only). Only data/ is that user's.
    if [ "$(id -u)" = 0 ]; then
      run chown "$RDV_UID:$RDV_GID" "$D/data"
      build_user=0:0
    else
      build_user="$RDV_UID:$RDV_GID"
    fi
    run docker run --rm --user "$build_user" --cap-drop ALL --security-opt no-new-privileges \
      -e HOME=/tmp -e npm_config_update_notifier=false \
      -v "$(here)/repo:/app" -w /app/impl "$NODE_IMAGE" sh -c 'npm ci --no-audit --no-fund && npm run build'
  else
    build_node
  fi
  [ "$DRY_RUN" = 1 ] || [ -f "$D/repo/impl/$GW_JS" ] || die "the build finished but $DIR/repo/impl/$GW_JS is missing"

  # The settings files, before anything runs through compose.
  save_conf
  if [ "$RUNTIME" = docker ]; then
    write_env
    write_compose
  fi
  done_step 4
}

setup_agent() {
  step 5 'your agent'
  if [ -f "$D/data/agent.json" ]; then
    say 'An agent is already set up here; keeping it:'
    tool run rdv whoami || true
    done_step 5
    return
  fi
  if [ -z "$AGENT" ]; then
    say 'new: a new agent for an email address (best for a first try: use a test address).'
    say 'restore: bring back an agent you already have, from its encrypted .rdvbackup file.'
    while :; do
      ask --agent 'Agent: new or restore' new
      case $ANSWER in new | restore) AGENT=$ANSWER; break ;; *) say 'Type new or restore.' ;; esac
    done
  fi
  case $AGENT in
    new)
      if [ -z "$EMAILS" ]; then
        while :; do
          ask --email 'Email address for this agent' ''
          valid_email "$ANSWER" && break
          say "That is not an email address: $ANSWER"
        done
        EMAILS=$ANSWER
        while ask_yn --email 'Add another email?' n; do
          ask --email 'Another email address' ''
          if valid_email "$ANSWER"; then EMAILS="$EMAILS $ANSWER"; else say "That is not an email address: $ANSWER"; fi
        done
      fi
      for e in $EMAILS; do valid_email "$e" || die "not an email address: $e"; done
      if [ -z "$RELAYS" ]; then
        say "Relays: $DEFAULT_RELAYS"
        if ask_yn --relay 'Use these relays?' y; then RELAYS=$DEFAULT_RELAYS
        else
          ask --relay 'Relays, separated by spaces (wss://...)' ''
          RELAYS=$ANSWER
        fi
      fi
      for r in $RELAYS; do valid_relay "$r" || die "not a relay address (wss://host): $r"; done
      if [ -z "$POINTER" ]; then
        say 'A public pointer lets anyone who knows your email find this agent and ask for contact (you still approve each one).'
        if ask_yn --public-pointer 'Make it findable by email?' n; then POINTER=1; else POINTER=0; fi
      fi
      set -- init
      for e in $EMAILS; do set -- "$@" --email "$e"; done
      for r in $RELAYS; do set -- "$@" --relay "$r"; done
      [ "$POINTER" = 1 ] && set -- "$@" --public-pointer
      tool run rdv "$@" || die 'rdv init failed'
      if [ "$POINTER" = 1 ]; then tool run rdv card publish || warn 'publishing the card failed; run ./gw rdv card publish later'; fi
      ;;
    restore)
      if [ -z "$BACKUP" ]; then
        ask --backup 'Path to the .rdvbackup file' ''
        BACKUP=$ANSWER
      fi
      BACKUP=$(abs_path "$BACKUP")
      [ -f "$BACKUP" ] && [ -r "$BACKUP" ] || [ "$DRY_RUN" = 1 ] || die "cannot read the backup file: $BACKUP"
      tty_ok || [ "$DRY_RUN" = 1 ] || die 'restoring asks for the passphrase: run this from your own terminal'
      say 'Next, rdv shows the agent ID and fingerprint in the file and asks for its passphrase. Check they are yours, then type it.'
      if [ "$RUNTIME" = docker ]; then
        # A private copy the container's user can read; removed right after.
        run mkdir -p "$D/.restore"
        run chmod 700 "$D/.restore"
        run cp "$BACKUP" "$D/.restore/agent.rdvbackup"
        if [ "$(id -u)" = 0 ]; then run chown -R "$RDV_UID:$RDV_GID" "$D/.restore"; fi
        st=0
        run_tty compose run --rm --no-deps -v "$(here)/.restore:/backup:ro" gateway node "$CLI_JS" restore /backup/agent.rdvbackup --home /data || st=$?
        run rm -rf "$D/.restore"
        [ "$st" = 0 ] || die 'restore failed (a wrong passphrase restores nothing); run this again to retry'
      else
        run_tty "$NODE_BIN" "$D/repo/impl/$CLI_JS" restore "$BACKUP" --home "$D/data" || die 'restore failed (a wrong passphrase restores nothing); run this again to retry'
      fi
      say 'Only one machine should receive for an agent: stop rdv listen / rdv-mcp for it on the old one.'
      ;;
    *) die "--agent is new or restore (got: $AGENT)" ;;
  esac
  tool run rdv whoami || true
  done_step 5
}

setup_pin() {
  step 6 'the approval PIN'
  if [ ! -L "$D/data/gateway.json" ] && [ -f "$D/data/gateway.json" ] && grep -q '"owner"' "$D/data/gateway.json" 2>/dev/null; then
    if [ "$UPDATE" = 1 ] || ask_yn --update 'An approval PIN is set. Keep it?' y; then
      say 'Keeping the PIN.'
      done_step 6
      return
    fi
  fi
  say 'You unlock the approval page with this PIN; it is what keeps an assistant from approving things itself.'
  say 'Choose 6 or more characters you use nowhere else. Nothing is shown as you type. Type only the PIN.'
  tty_ok || [ "$DRY_RUN" = 1 ] || die 'setting the PIN needs your own terminal: run this from one (ssh -t is fine)'
  tool run_tty gw pin set || die 'the PIN was not set; run this again to retry'
  done_step 6
}

start_quick_tunnel() {
  # The quick tunnel's address is known only once it runs.
  if [ "$RUNTIME" = docker ]; then
    run compose up -d tunnel
  fi
  [ "$DRY_RUN" = 1 ] && { PUBLIC_URL=https://example-words.trycloudflare.com; return 0; }
  i=0
  url=
  while [ $i -lt 30 ]; do
    if [ "$RUNTIME" = docker ]; then logs=$(compose logs --no-color tunnel 2>&1 || true)
    else logs=$(cat "$D/logs/cloudflared.log" 2>/dev/null || true); fi
    url=$(quick_url_from "$logs")
    [ -n "$url" ] && break
    i=$((i + 1))
    sleep 2
  done
  [ -n "$url" ] || die 'the quick tunnel did not report its address; see ./gw logs tunnel'
  PUBLIC_URL=$url
  save_conf
  [ "$RUNTIME" = docker ] && write_env
  return 0
}

start_services() {
  step 7 'start it and check'
  UNINSTALL_EXTRA=':'
  if [ "$TUNNEL" = tailscale ]; then
    UNINSTALL_EXTRA='tailscale funnel --https=443 off || echo "turn Tailscale Funnel off by hand (see: tailscale funnel status)"'
    if ! run tailscale funnel --bg "$PORT"; then
      die "tailscale funnel failed. On Linux your user may need to be its operator first: sudo tailscale set --operator=\$USER (then run this again), and Funnel must be allowed in your tailnet's policy"
    fi
  fi
  if [ "$RUNTIME" = docker ]; then
    [ "$TUNNEL" = cloudflare-quick ] && start_quick_tunnel
    # A new token reaches cloudflared only through a new container: it reads the file once, at start.
    if has_tunnel_service && [ "$TUNNEL" != cloudflare-quick ]; then
      if [ "$TOKEN_CHANGED" = 1 ]; then run compose up -d --force-recreate tunnel; else run compose up -d tunnel; fi
    fi
    run compose up -d --force-recreate --remove-orphans gateway
  else
    SERVICE_FUNCS=$(service_funcs)
    if [ "$(uname -s)" = Darwin ]; then
      run mkdir -p "$AGENTS_DIR"
      d="gui/$(id -u)"
      if [ "$TUNNEL" = cloudflare-quick ]; then
        run rm -f "$D/logs/cloudflared.log"
        write_launchd_agents
        run launchctl bootout "$d/co.nesher.rdv-gateway-tunnel" 2>/dev/null || true
        run launchctl bootstrap "$d" "$AGENTS_DIR/co.nesher.rdv-gateway-tunnel.plist"
        start_quick_tunnel
      fi
      write_launchd_agents
      for l in co.nesher.rdv-gateway-tunnel co.nesher.rdv-gateway; do
        [ "$l" = co.nesher.rdv-gateway-tunnel ] && { ! has_tunnel_service || [ "$TUNNEL" = cloudflare-quick ]; } && continue
        run launchctl bootout "$d/$l" 2>/dev/null || true
        run launchctl bootstrap "$d" "$AGENTS_DIR/$l.plist"
      done
    else
      run mkdir -p "$UNIT_DIR"
      if [ "$TUNNEL" = cloudflare-quick ]; then
        run rm -f "$D/logs/cloudflared.log"
        write_systemd_units
        run systemctl --user daemon-reload
        run systemctl --user enable rdv-gateway-tunnel
        run systemctl --user restart rdv-gateway-tunnel
        start_quick_tunnel
      fi
      write_systemd_units
      run systemctl --user daemon-reload
      run systemctl --user enable rdv-gateway
      has_tunnel_service && [ "$TUNNEL" != cloudflare-quick ] && { run systemctl --user enable rdv-gateway-tunnel; run systemctl --user restart rdv-gateway-tunnel; }
      run systemctl --user restart rdv-gateway
      if [ "$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)" != Linger=yes ]; then
        warn "the gateway stops when you log out. To keep it running, run once: loginctl enable-linger $(id -un)"
      fi
    fi
  fi
  [ -n "${SERVICE_FUNCS:-}" ] || SERVICE_FUNCS=$(service_funcs)
  write_ctl

  if [ "$DRY_RUN" = 1 ]; then done_step 7; return 0; fi
  i=0
  until http_ok "http://127.0.0.1:$PORT/healthz"; do
    i=$((i + 1))
    [ $i -lt 30 ] || die "the gateway did not answer on 127.0.0.1:$PORT; see $DIR/gw logs"
    sleep 2
  done
  say "Local check: http://127.0.0.1:$PORT/healthz answers."
  i=0
  until http_ok "$PUBLIC_URL/healthz"; do
    i=$((i + 1))
    if [ $i -ge 20 ]; then
      warn "$PUBLIC_URL/healthz does not answer yet. Check the tunnel or proxy ($DIR/gw logs tunnel), then: curl $PUBLIC_URL/healthz"
      break
    fi
    sleep 3
  done
  [ $i -ge 20 ] || say "Public check: $PUBLIC_URL/healthz answers."
  done_step 7
}

# Each further agent on this gateway (data/agents/<name>/, from ./gw agent add) and its own MCP address.
agent_urls() {
  [ -d "$D/data/agents" ] || return 0
  set +f # main turns globbing off for the word-split lists; this one glob is ours
  for a in "$D"/data/agents/*/; do
    [ -d "$a" ] || continue
    n=$(basename "$a")
    case $n in .* | *[!A-Za-z0-9_-]*) continue ;; esac
    printf '  agent %-10s %s/a/%s/mcp\n' "$n" "$PUBLIC_URL" "$n"
  done
  set -f
}

next_steps() {
  cat <<EOF

The Rendezvous gateway is running.

Your MCP address:  $PUBLIC_URL/mcp
$(agent_urls)
Connect your assistants (each one sends you to the gateway's page; unlock it with your PIN,
and check that the return address is claude.ai or chatgpt.com before you approve):
  claude.ai     Settings, Connectors, Add custom connector: paste the MCP address,
                leave the client ID and secret empty.
  ChatGPT       Settings, Connectors, Advanced: developer mode on; create a connector
                with the MCP address, authentication OAuth.
  Claude Code   claude mcp add --transport http rendezvous $PUBLIC_URL/mcp
                then /mcp inside Claude Code to sign in.
  Others (Hermes, a Custom GPT, scripts) use a bearer token you make yourself, shown once:
                $DIR/gw token create --name hermes --scope read,send
                (OpenAPI for GPT Actions: $PUBLIC_URL/openapi.json)

Manage it from $DIR:
  ./gw status            is it up?
  ./gw logs              follow the gateway's log (./gw logs tunnel for the tunnel)
  ./gw update            pull, rebuild and restart, keeping your settings (or run this installer again)
  ./gw stop | ./gw start
  ./gw rdv whoami        the agent's ID and fingerprint
  ./gw oauth list        connected assistants (./gw oauth revoke <id> to cut one off)
  ./gw agent add <name> new --email <address>   another agent on this gateway, then ./gw restart
                         (in your own terminal; its address is $PUBLIC_URL/a/<name>/mcp)
  ./gw uninstall         stop and remove the service; your agent stays in data/

Keep data/ private and backed up (./gw backup <file>): it holds the agent's key.
Docs: https://rendezvous.nesher.co/docs/gateway-deploy.html
EOF
  if [ "$TUNNEL" = cloudflare-quick ]; then
    warn 'this is a quick tunnel: after a restart its address changes. Run ./gw update to pick up the new one, then connect your assistants again.'
  fi
}

main() {
  [ -n "${HOME:-}" ] || die 'HOME is not set'
  DIR='' D='' RUNTIME='' REF='' PORT='' AGENT='' EMAILS='' RELAYS='' POINTER='' BACKUP=''
  C_RUNTIME='' C_REF='' C_PORT='' C_TUNNEL='' C_PUBLIC_URL='' C_HEADER=''
  TUNNEL='' PUBLIC_URL='' CLIENT_IP_HEADER='' UPDATE=0 YES=0 DRY_RUN=0 ALLOW_ROOT=0 COMPOSE=''
  SERVICE_FUNCS='' UNINSTALL_EXTRA=: CLOUDFLARED_BIN='' NODE_BIN=node SECRET='' UID_FLAG='' TOKEN_CHANGED=0
  NODE_IMAGE=${RDV_NODE_IMAGE:-$NODE_IMAGE_DEFAULT}
  CLOUDFLARED_IMAGE=${RDV_CLOUDFLARED_IMAGE:-$CLOUDFLARED_IMAGE_DEFAULT}
  while [ $# -gt 0 ]; do
    opt=$1
    case $opt in
      --*=*) val=${opt#*=}; opt=${opt%%=*}; shift; set -- "$opt" "$val" "$@" ;;
    esac
    case $1 in
      -h | --help) usage; exit 0 ;;
      --update) UPDATE=1; YES=1 ;;
      --yes | -y) YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --allow-root) ALLOW_ROOT=1 ;;
      --public-pointer) POINTER=1 ;;
      --no-public-pointer) POINTER=0 ;;
      --pin | --passphrase | --password | --token | --tunnel-token | --secret)
        die "$1 is not an option on purpose: secrets are typed in your terminal when asked, never passed as arguments (they would land in your shell history and process list)" ;;
      --dir | --runtime | --ref | --port | --agent | --email | --relay | --backup | --tunnel | --public-url | --client-ip-header | --uid)
        [ $# -ge 2 ] || die "$1 needs a value"
        case $1 in
          --uid) UID_FLAG=$2 ;;
          --dir) DIR=$2 ;;
          --runtime) RUNTIME=$2 ;;
          --ref) REF=$2 ;;
          --port) PORT=$2 ;;
          --agent) AGENT=$2 ;;
          --email) EMAILS="${EMAILS:+$EMAILS }$2" ;;
          --relay) RELAYS="${RELAYS:+$RELAYS }$2" ;;
          --backup) BACKUP=$2 ;;
          --tunnel) TUNNEL=$2 ;;
          --public-url) PUBLIC_URL=$2 ;;
          --client-ip-header) CLIENT_IP_HEADER=$2 ;;
        esac
        shift ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  # Emails and relays are word-split later: validate them before anything else sees them.
  set -f
  for e in $EMAILS; do valid_email "$e" || die "not an email address: $e"; done
  for r in $RELAYS; do valid_relay "$r" || die "not a relay address (wss://host): $r"; done

  RDV_UID=$(id -u) RDV_GID=$(id -g)

  [ "$DRY_RUN" = 1 ] && say 'Dry run: nothing is changed, nothing is downloaded.'
  say 'Rendezvous gateway installer. Questions come one at a time; press Enter to take the [default].'
  if [ "$(id -u)" = 0 ] && [ "$ALLOW_ROOT" != 1 ]; then
    die 'do not run this as root. Your user needs only Docker access (the docker group) or Node.js, and the agent key should belong to you. On a NAS where only root can use Docker, run it with sudo and --allow-root: the gateway then runs as the user who ran sudo (or --uid), who owns only data/, in a locked-down container.'
  fi
  command -v git >/dev/null 2>&1 || die "git is required but was not found. Install it with: $(pkg_hint git), then run this again"
  choose_dir_and_settings
  choose_runtime
  choose_public_address
  fetch_and_build
  setup_agent
  setup_pin
  start_services
  next_steps
}

# Tests source this file with RDV_GW_SOURCE_ONLY=1 to call the functions above.
[ "${RDV_GW_SOURCE_ONLY:-0}" = 1 ] || main "$@"
