#!/usr/bin/env bash
# Pre-commit check for this public repository: fails when a file (or a commit message) contains
# private paths, internal network addresses, credential values, or numbered internal document references.
#
# Usage:
#   scripts/check-public.sh                 # scan every file in the working tree (except dependencies and build output)
#   scripts/check-public.sh --message FILE  # also scan a commit message
# Exit code 0 means nothing was found; 1 means at least one line matched and is printed.
#
# An optional private rules file adds more patterns, one extended regular expression per line:
#   ${TASKWRIGHT_CHECK_RULES:-~/.config/taskwright/check-public.local}
# Keep that file outside the repository.

set -u
cd "$(dirname "$0")/.."

# Each pattern is written so that it does not match its own text in this file.
PATTERNS=(
  '《0[0-9]'                                   # numbered design documents
  '增量 ?[0-9]'                                # numbered increments
  '附录 ?[A-Z]\b'                              # appendix letters
  '第[一二三四五六七八九十]稿'                     # draft numbers
  '/hom[e]/'                                   # private home-directory paths
  '192\.168\.[0-9]'                            # private network addresses
  '(^|[^0-9.])10\.[0-9]+\.[0-9]+\.[0-9]+'
  '172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+'
  '(sk|pk)-lf-[0-9a-f]'                        # Langfuse key values
  'sk-[A-Za-z0-9]{20,}'                        # generic API key values
  '(SECRET|secret|PASSWORD|password|API_KEY|api_key)[A-Za-z_]*\s*=\s*["'"'"']?[A-Za-z0-9/+_-]{12,}'
  'Co-Authored-B[y]'
  '@gmail\.com'
)

RULES="${TASKWRIGHT_CHECK_RULES:-$HOME/.config/taskwright/check-public.local}"
if [ -f "$RULES" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && [ "${line#\#}" = "$line" ] && PATTERNS+=("$line")
  done < "$RULES"
fi

EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=__pycache__
          --exclude-dir=.vite --exclude-dir=.venv --exclude=package-lock.json --exclude=LICENSE
          --exclude=CODE_OF_CONDUCT.md)

# Inside a git work tree, scan exactly what git would commit (tracked plus untracked-but-not-ignored),
# so run output such as tasks/ and runs/ is skipped; elsewhere, scan the whole tree.
FILES=()
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' f; do
    case "$f" in package-lock.json|*/package-lock.json|LICENSE|CODE_OF_CONDUCT.md) continue ;; esac
    [ -f "$f" ] && FILES+=("$f")
  done < <(git -c core.quotepath=off ls-files -z -co --exclude-standard)
fi

scan() {
  if [ ${#FILES[@]} -gt 0 ]; then
    grep -nIE -e "$1" -- "${FILES[@]}" 2>/dev/null
  else
    grep -rnIE "${EXCLUDES[@]}" -e "$1" . 2>/dev/null
  fi
}

status=0
for p in "${PATTERNS[@]}"; do
  if out=$(scan "$p"); then
    echo "== pattern: $p"
    echo "$out"
    status=1
  fi
done

if [ "${1:-}" = "--message" ] && [ -n "${2:-}" ]; then
  for p in "${PATTERNS[@]}"; do
    if out=$(grep -nIE -e "$p" "$2"); then
      echo "== commit message, pattern: $p"
      echo "$out"
      status=1
    fi
  done
fi

if [ $status -eq 0 ]; then echo "check_public: nothing found."; fi
exit $status
