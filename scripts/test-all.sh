#!/usr/bin/env bash
# Runs every test suite and the web build. Needs Node 24+, Python 3.12+ with pytest, and the pi CLI on PATH
# for the integration tests (they use a local fake model endpoint, never a real model service).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PYTHONPATH="$ROOT/server:$ROOT/observatory:$ROOT"      # set fresh, not inherited: stray plugins on an inherited path can break collection

echo "== agent (node --test)";  (cd agent && node --test 'tests/*.test.ts')
echo "== sim (node --test)";    (cd sim && node --test 'tests/*.test.ts')
echo "== web (vitest)";         npm test -w web
echo "== web (build)";          npm run build -w web
echo "== server, observatory and sim (pytest)"; python3 -m pytest server observatory sim -q
