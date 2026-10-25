#!/bin/sh
# Publishes the `skill` branch: the skill folder as the repository root, for
# installers that need SKILL.md at the root of a ref (OpenClaw:
# `openclaw skills install git:omernesh/rendezvous@skill`).
#
# The branch is generated from plugins/rendezvous/skills/rendezvous with
# `git subtree split`, so the skill text exists once. Run it from a clean
# checkout of main after the skill changes; it force-pushes `skill`.
#
#   sh scripts/publish-skill-branch.sh [remote]     (default remote: origin)
set -eu

REMOTE=${1:-origin}
PREFIX=plugins/rendezvous/skills/rendezvous
BRANCH=skill

cd "$(git rev-parse --show-toplevel)"
[ -f "$PREFIX/SKILL.md" ] || { echo "publish-skill-branch: $PREFIX/SKILL.md not found" >&2; exit 1; }
[ -z "$(git status --porcelain -- "$PREFIX")" ] || { echo "publish-skill-branch: uncommitted changes in $PREFIX" >&2; exit 1; }

sha=$(git subtree split --prefix="$PREFIX" HEAD)
git ls-tree --name-only "$sha" | grep -qx 'SKILL.md' || { echo "publish-skill-branch: SKILL.md is not at the root of $sha" >&2; exit 1; }
git push --force "$REMOTE" "$sha:refs/heads/$BRANCH"
echo "published $BRANCH at $sha (skill from $(git rev-parse --short HEAD))"
echo "install: openclaw skills install git:omernesh/rendezvous@$BRANCH   (pin with @$sha)"
