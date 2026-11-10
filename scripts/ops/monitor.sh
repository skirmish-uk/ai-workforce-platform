#!/bin/sh
# Uptime and backup monitor for the demo stack (docs/DEPLOY.md "Backups and alerts"). Runs in
# the `monitor` service of compose.prod.yml. Every minute it checks:
#   - the site's health (database, Redis and the worker: /api/health), down after 3 failures;
#   - the newest backup in /backups is under BACKUP_MAX_AGE_HOURS old.
# It alerts once when something goes wrong and once when it recovers, to ALERT_WEBHOOK_URL
# (ntfy topic URL, Slack or Discord webhook); without one it only logs. It runs inside the
# stack, so it can't report the whole server being down: use an outside uptime check for that.
set -u

HEALTH_URL=${HEALTH_URL:-http://web:3000/api/health}
MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-26}
INTERVAL=${MONITOR_INTERVAL_S:-60}
SITE=${DOMAIN:-the demo}

log() { echo "[monitor] $(date -u +%FT%TZ) $*"; }

alert() { # title, message
  log "ALERT $1: $2"
  url=${ALERT_WEBHOOK_URL:-}
  [ -n "$url" ] || return 0
  text=$(printf '%s\n%s' "$1" "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{ printf "%s\\n", $0 }')
  case "$url" in
    https://hooks.slack.com/*) curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"text\":\"$text\"}" "$url" >/dev/null ;;
    https://discord.com/api/webhooks/* | https://*.discord.com/api/webhooks/*) curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"content\":\"$text\"}" "$url" >/dev/null ;;
    *) curl -fsS -m 10 -H "Title: $1" -d "$2" "$url" >/dev/null ;;
  esac || log "could not deliver the alert"
}

fails=0
site_down=0
backup_stale=0
started=$(date +%s)
if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then target=webhook; else target='log only'; fi
log "watching $HEALTH_URL and /backups (alerts: $target)"
while true; do
  body=$(curl -fsS -m 15 "$HEALTH_URL" 2>&1) && echo "$body" | grep -q '"status":"\(healthy\|degraded\)"' && ok=1 || ok=0
  if [ "$ok" -eq 1 ]; then
    if [ "$site_down" -eq 1 ]; then alert "$SITE is back up" "Health checks pass again."; fi
    fails=0; site_down=0
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 3 ] && [ "$site_down" -eq 0 ]; then
      site_down=1
      alert "$SITE is down" "Health check failed 3 times in a row: $(echo "$body" | head -c 600)"
    fi
  fi

  newest=$(ls -1t /backups/ai_workforce-*.dump 2>/dev/null | head -1)
  if [ -n "$newest" ]; then age=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 )); else age=9999; fi
  if [ "$age" -ge "$MAX_AGE_HOURS" ]; then
    # Not in the first 10 minutes: the backup service makes its first backup soon after boot.
    if [ "$backup_stale" -eq 0 ] && [ $(( $(date +%s) - started )) -ge 600 ]; then backup_stale=1; alert "$SITE backup missed" "The newest database backup is ${age} h old (limit ${MAX_AGE_HOURS} h). Check: scripts/demo-deploy.sh backup-logs"; fi
  elif [ "$backup_stale" -eq 1 ]; then
    backup_stale=0; alert "$SITE backups are running again" "Newest backup: $(basename "$newest")"
  fi

  sleep "$INTERVAL"
done
