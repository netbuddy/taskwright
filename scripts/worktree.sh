#!/usr/bin/env bash
# Parallel work: one git worktree (and one branch) per person or agent session, next to the main checkout.
#
# Usage:
#   scripts/worktree.sh new <name> [<branch>]   create ../<repo>-worktrees/<name> on branch wt/<name> (or <branch>)
#   scripts/worktree.sh remove <name> [--force] remove that worktree; the branch is kept (--force: also its tasks/ and runs/)
#   scripts/worktree.sh relink <name>           rebuild the worktree's node_modules/ links (after an accidental npm install or npm ci)
#
# A new worktree gets:
#   - node_modules/ that links, package by package, to the main checkout's node_modules/ (nothing is downloaded);
#   - no docs/: a sparse checkout set for that worktree only leaves the top-level docs/ out; the documentation is
#     maintained in the main checkout, and a worktree's branch must not change docs/;
#   - its own Python virtual environment .venv/ with observatory[test] and server[test] installed in editable mode
#     (uv is used when it is on PATH, otherwise python3 -m venv and pip).
#
# Why package by package and not one link for the whole node_modules/: npm clears node_modules/ before any
# lifecycle script can stop it, and it clears it through a symbolic link, so `npm ci` in a worktree whose
# node_modules/ is one link would empty the main checkout's node_modules/. With a real node_modules/ directory
# that holds one link per package (scope directories such as @types/ and .bin/ are real directories too),
# npm only removes the worktree's own links. Do not run npm install or npm ci in a worktree anyway: the preinstall
# guard (scripts/guard-node-modules.mjs) refuses `npm install`, but only after npm has already removed most links,
# and `npm ci` cannot be refused at all (it installs a full copy into the worktree). Run `relink` afterwards.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMMON="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)"
MAIN="$(dirname "$COMMON")"                            # the main checkout, also when this runs inside a worktree
BASE="$(dirname "$MAIN")/$(basename "$MAIN")-worktrees"
MARKER=".taskwright-linked"

usage() { sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
die() { echo "worktree.sh: $*" >&2; exit 1; }

check_name() {
  [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "the name may contain only letters, digits, '.', '_' and '-': '${1:-}'"
}

# One entry of node_modules/: keep relative links as they are (workspace packages such as taskwright-web -> ../web
# then point at the worktree's own directories, and .bin/ entries at the worktree's links), link everything else
# to the main checkout by absolute path.
link_one() {
  local src="$1" dst="$2"
  if [ -L "$src" ] && [[ "$(readlink "$src")" != /* ]]; then
    ln -s "$(readlink "$src")" "$dst"
  else
    ln -s "$src" "$dst"
  fi
}

link_modules() {
  local src="$1" dst="$2" entry name child
  mkdir "$dst"
  printf 'This node_modules/ links, package by package, to %s.\nDo not run npm install or npm ci here; see scripts/worktree.sh.\n' "$src" > "$dst/$MARKER"
  for entry in "$src"/* "$src"/.bin; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    if [[ "$name" == @* || "$name" == .bin ]]; then
      mkdir "$dst/$name"
      for child in "$entry"/* "$entry"/.[!.]*; do
        [ -e "$child" ] || [ -L "$child" ] || continue
        link_one "$child" "$dst/$name/$(basename "$child")"
      done
    else
      link_one "$entry" "$dst/$name"
    fi
  done
}

make_venv() {
  local dir="$1"
  if command -v uv >/dev/null 2>&1; then
    echo "   using uv"
    uv venv --quiet --python python3 "$dir/.venv"
    (cd "$dir" && uv pip install --quiet --python .venv/bin/python -e 'observatory[test]' -e 'server[test]')
  else
    echo "   using python3 -m venv and pip"
    python3 -m venv "$dir/.venv"
    (cd "$dir" && .venv/bin/python -m pip install --quiet -e 'observatory[test]' -e 'server[test]')
  fi
}

cmd_new() {
  local name="${1:-}" branch="${2:-}"
  check_name "$name"
  branch="${branch:-wt/$name}"
  local dir="$BASE/$name"
  [ ! -e "$dir" ] || die "$dir already exists"
  git -C "$MAIN" rev-parse --verify --quiet HEAD >/dev/null || die "the repository has no commit yet; commit first, then create worktrees"
  [ -d "$MAIN/node_modules" ] || die "$MAIN/node_modules is missing; run npm ci in the main checkout first"
  [ ! -e "$MAIN/node_modules/$MARKER" ] || die "$MAIN/node_modules is itself a linked tree; run npm ci in the main checkout first"

  echo "1. git worktree: $dir (branch $branch)"
  mkdir -p "$BASE"
  if git -C "$MAIN" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN" worktree add --quiet --no-checkout "$dir" "$branch"
  else
    git -C "$MAIN" worktree add --quiet --no-checkout -b "$branch" "$dir" HEAD
  fi
  # Sparse checkout for this worktree only: extensions.worktreeConfig keeps core.sparseCheckout in the worktree's
  # own config.worktree, so the main checkout and other worktrees still check out everything.
  git -C "$MAIN" config extensions.worktreeConfig true
  git -C "$dir" sparse-checkout set --no-cone '/*' '!/docs/'
  git -C "$dir" checkout --quiet

  echo "2. node_modules: linking to $MAIN/node_modules"
  link_modules "$MAIN/node_modules" "$dir/node_modules"

  echo "3. Python virtual environment: $dir/.venv"
  make_venv "$dir"

  cat <<EOF

Done. Next:
  cd $dir
  . .venv/bin/activate                     # in every new terminal, before any python3 command
  TASKWRIGHT_API_PORT=<port> TASKWRIGHT_WEB_PORT=<port> scripts/dev.sh
Pick ports no other worktree uses. Do not run npm install or npm ci here.
This worktree has no docs/; describe documentation changes in the commit message instead.
Remove it later with: scripts/worktree.sh remove $name   (the branch $branch is kept)
EOF
}

cmd_relink() {
  local name="${1:-}"
  check_name "$name"
  local dir="$BASE/$name"
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || die "no worktree at $dir"
  [ ! -L "$dir/node_modules" ] || die "$dir/node_modules is a symbolic link; remove that link yourself first"
  rm -rf "$dir/node_modules"   # the worktree's own directory; rm does not follow the links inside it
  link_modules "$MAIN/node_modules" "$dir/node_modules"
  echo "relinked $dir/node_modules to $MAIN/node_modules"
}

cmd_remove() {
  local name="${1:-}" force="${2:-}"
  check_name "$name"
  [ -z "$force" ] || [ "$force" = "--force" ] || die "unknown option '$force' (only --force)"
  local dir="$BASE/$name"
  [ -d "$dir" ] || die "no worktree at $dir"
  local branch
  branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    die "$dir has uncommitted changes; commit or stash them first (or run git worktree remove --force yourself)"
  fi
  # Task directories and archives are ignored by git, so git would delete them silently: list them and stop.
  local kept=() sub
  for sub in tasks runs; do
    if [ -d "$dir/$sub" ] && [ -n "$(ls -A "$dir/$sub")" ]; then kept+=("$sub"); fi
  done
  if [ ${#kept[@]} -gt 0 ] && [ "$force" != "--force" ]; then
    echo "worktree.sh: $dir still has run output that removing would delete:" >&2
    for sub in "${kept[@]}"; do
      echo "  $sub/: $(ls -A "$dir/$sub" | tr '\n' ' ')" >&2
    done
    die "copy out what you want to keep, then run: scripts/worktree.sh remove $name --force"
  fi
  # Remove the links first: rm never follows a symbolic link, but deleting the links explicitly makes that obvious.
  if [ -d "$dir/node_modules" ] && [ -e "$dir/node_modules/$MARKER" ]; then
    find "$dir/node_modules" -mindepth 1 -type l -delete
  fi
  git -C "$MAIN" worktree remove --force "$dir"   # --force only for the ignored .venv/, node_modules/, runs/, tasks/; status was checked above
  echo "removed $dir; branch $branch is kept"
  echo "Before merging it, check that it does not touch docs/: git diff --stat main...$branch -- docs/   (must print nothing)"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  remove) shift; cmd_remove "$@" ;;
  relink) shift; cmd_relink "$@" ;;
  *) usage ;;
esac
