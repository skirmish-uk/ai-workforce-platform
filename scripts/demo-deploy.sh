#!/usr/bin/env bash
# Production demo on a Docker host with nginx-proxy + acme-companion (docs/DEPLOY.md).
#   scripts/demo-deploy.sh up        build and (re)start everything
#   scripts/demo-deploy.sh logs      follow web + worker logs
#   scripts/demo-deploy.sh restart   recreate web + worker (picks up .env.production changes)
#   scripts/demo-deploy.sh ps|down|reset-demo|stage-repair
# Always passes .env.production for variable substitution, so ${DOMAIN} etc. never come from
# the development .env that sits next to it.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.production ] || { echo "Missing .env.production (copy .env.production.example)"; exit 1; }
dc() { docker compose -p ai-workforce-demo -f compose.prod.yml --env-file .env.production "$@"; }
case "${1:-up}" in
  up) dc up -d --build --remove-orphans && dc ps ;;
  logs) dc logs -f --tail=100 web worker ;;
  ps) dc ps ;;
  down) dc down ;;
  # Recreate (not `docker compose restart`, which keeps the old environment) so edits to
  # .env.production take effect.
  restart) dc up -d --no-build --no-deps --force-recreate web worker && dc ps ;;
  # Clear demo activity (keeps agents' tested upgrades): npm run demo:reset inside the stack.
  reset-demo) dc run --rm --no-deps setup sh -c "npx tsx scripts/reset-demo.ts" && dc restart worker ;;
  # Self-repair moment: Jordan's three flagged runs (DEMO.md). Run after reset-demo, 10+ min before.
  stage-repair) dc run --rm --no-deps setup sh -c "npx tsx scripts/stage-repair.ts" ;;
  # Every agent's test suite on the real model (dry runs), recorded as evaluations; extra args pass through.
  evaluate) shift; dc run --rm --no-deps setup sh -c "npx tsx scripts/evaluate-team.ts $*" ;;
  *) echo "usage: $0 up|logs|ps|down|restart|reset-demo|stage-repair|evaluate"; exit 1 ;;
esac
