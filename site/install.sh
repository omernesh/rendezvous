#!/bin/sh
# Rendezvous installer for macOS and Linux (POSIX sh).
#
#   curl -fsSL https://rendezvous.nesher.co/install.sh | sh
#
# Clones (or updates) the reference implementation into ~/.rendezvous/src,
# builds it with npm, and writes `rdv` and `rdv-mcp` shims into ~/.local/bin.
# No sudo. Safe to run again: it pulls and rebuilds.
#
# Overrides (environment variables):
#   RDV_REPO     git URL or local path to clone   (default: https://github.com/omernesh/rendezvous)
#   RDV_DIR      where the clone lives            (default: ~/.rendezvous/src)
#   RDV_BIN_DIR  where the shims go               (default: ~/.local/bin)
#
# Note: rdv keeps profiles in ~/.rendezvous/<profile>, so don't name a profile "src".

# Everything runs from main(), called on the last line, so a download that is
# cut short executes nothing.

set -eu

MARKER='rendezvous-installer-shim'

die() {
  printf 'rendezvous install: error: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '==> %s\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH"
}

# Refuse paths that cannot be embedded safely in a double-quoted shim line.
check_path() {
  case "$1" in
    *'"'* | *'$'* | *'`'* | *'\'*) die "unsupported character in path: $1 (set $2 to a simpler path)" ;;
  esac
}

# Is the existing clone's origin the repo we were asked for? Local paths are
# compared after resolving them, since git may store them in another spelling.
same_repo() {
  [ "$1" = "$2" ] && return 0
  [ -d "$1" ] && [ -d "$2" ] || return 1
  a=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  b=$(git -C "$2" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  [ "$a" = "$b" ]
}

write_shim() {
  name=$1
  target=$2
  path="$BIN_DIR/$name"
  if [ -e "$path" ] && ! grep -q "$MARKER" "$path" 2>/dev/null; then
    die "$path already exists and was not written by this installer. Remove it or set RDV_BIN_DIR"
  fi
  tmp="$path.tmp.$$"
  printf '#!/bin/sh\n# %s\nexec node "%s" "$@"\n' "$MARKER" "$target" >"$tmp" || die "cannot write $tmp"
  chmod 755 "$tmp" || die "cannot chmod $tmp"
  mv -f "$tmp" "$path" || die "cannot move $tmp to $path"
}

main() {
  [ -n "${HOME:-}" ] || die 'HOME is not set'

  REPO=${RDV_REPO:-https://github.com/omernesh/rendezvous}
  DIR=${RDV_DIR:-$HOME/.rendezvous/src}
  BIN_DIR=${RDV_BIN_DIR:-$HOME/.local/bin}
  check_path "$DIR" RDV_DIR
  check_path "$BIN_DIR" RDV_BIN_DIR

  # --- prerequisites -------------------------------------------------------
  need git
  need node
  need npm
  node_version=$(node -p 'process.versions.node') || die 'could not read the Node.js version'
  node_major=${node_version%%.*}
  case "$node_major" in
    '' | *[!0-9]*) die "could not parse the Node.js version: $node_version" ;;
  esac
  [ "$node_major" -ge 20 ] || die "Node.js 20 or newer is required (found v$node_version). Get it from https://nodejs.org"
  step "node v$node_version, $(git --version), npm $(npm --version)"

  # --- clone or update ------------------------------------------------------
  if [ -d "$DIR/.git" ] || [ -f "$DIR/.git" ]; then
    origin=$(git -C "$DIR" remote get-url origin) || die "$DIR is a git clone without an 'origin' remote"
    same_repo "$origin" "$REPO" || die "$DIR is a clone of '$origin', not '$REPO'. Move it away or set RDV_DIR"
    step "Updating $DIR"
    git -C "$DIR" pull --ff-only || die "git pull failed in $DIR"
  elif [ -e "$DIR" ]; then
    die "$DIR exists but is not a git clone. Move it away or set RDV_DIR"
  else
    step "Cloning $REPO into $DIR"
    mkdir -p "$(dirname "$DIR")" || die "cannot create $(dirname "$DIR")"
    git clone "$REPO" "$DIR" || die "git clone $REPO failed"
  fi

  # --- build ----------------------------------------------------------------
  IMPL="$DIR/impl"
  [ -f "$IMPL/package.json" ] || die "$IMPL/package.json not found; is $REPO the Rendezvous repo?"
  step 'npm ci'
  (cd "$IMPL" && npm ci --no-audit --no-fund) || die 'npm ci failed'
  step 'npm run build'
  (cd "$IMPL" && npm run build) || die 'npm run build failed'

  RDV_JS="$IMPL/packages/cli/dist/src/bin.js"
  MCP_JS="$IMPL/packages/mcp/dist/src/bin.js"
  [ -f "$RDV_JS" ] || die "build finished but $RDV_JS is missing"
  [ -f "$MCP_JS" ] || die "build finished but $MCP_JS is missing"

  # --- shims ----------------------------------------------------------------
  mkdir -p "$BIN_DIR" || die "cannot create $BIN_DIR"
  write_shim rdv "$RDV_JS"
  write_shim rdv-mcp "$MCP_JS"
  step "Wrote rdv and rdv-mcp shims to $BIN_DIR"

  # Smoke test through the shim, not the build output.
  "$BIN_DIR/rdv" --help >/dev/null || die "rdv --help failed after install"

  printf '\nRendezvous is installed.\n'
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      printf '\nWARNING: %s is not on your PATH, so `rdv` will not be found yet.\n' "$BIN_DIR" >&2
      printf 'Add this line to your shell profile (~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:\n' >&2
      printf '  export PATH="%s:$PATH"\n' "$BIN_DIR" >&2
      ;;
  esac
  cat <<EOF

Next steps:
  rdv init --profile omer --email omer@example.com --relay wss://relay.nesher.co
  rdv whoami --profile omer
  rdv listen --profile omer

Or let Claude Code do the rest: in its chat, type
  /plugin marketplace add omernesh/rendezvous
  /plugin install rendezvous@rendezvous
  /reload-plugins
then ask "Set up Rendezvous for me". (Without the plugin:
  claude mcp add rendezvous -- rdv-mcp --profile omer)

Update later by running the installer again. Docs: https://rendezvous.nesher.co
EOF
}

main "$@"
