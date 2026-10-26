#!/bin/sh
# Database backups for the demo stack (docs/DEPLOY.md "Backups and alerts"). Runs in the
# `backup` service of compose.prod.yml (Postgres client tools, PG* variables set there):
#   backup.sh loop          nightly at BACKUP_HOUR_UTC, plus one at start if the last is >25 h old
#   backup.sh once          one backup now
#   backup.sh restore-test  restore the latest backup into a scratch database and check it
# Backups are custom-format pg_dump files in /backups (the `backups` volume), kept
# BACKUP_KEEP_DAYS days, each with the row counts of key tables before and after the dump.
set -eu

DIR=/backups
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
HOUR=${BACKUP_HOUR_UTC:-16} # 16:00 UTC: 3 am in Sydney during daylight saving
SCRATCH=ai_workforce_restore_test
TABLES='Tenant User Agent Skill AgentSkill AgentPermission KnowledgeDocument KnowledgeChunk Memory AgentRevision Evaluation Approval Integration'

log() { echo "[backup] $(date -u +%FT%TZ) $*"; }

counts() { # database -> "Table count" lines
  for t in $TABLES; do echo "$t $(psql -d "$1" -At -c "SELECT count(*) FROM \"$t\"")"; done
}

once() {
  mkdir -p "$DIR"
  stamp=$(date -u +%Y%m%d-%H%M%S)
  base="$DIR/ai_workforce-$stamp"
  counts "$PGDATABASE" > "$base.before"
  pg_dump -Fc -f "$base.partial"
  counts "$PGDATABASE" > "$base.after"
  mv "$base.partial" "$base.dump"
  find "$DIR" -name 'ai_workforce-*' -mtime "+$KEEP_DAYS" -delete
  log "saved $(basename "$base.dump") ($(du -h "$base.dump" | cut -f1)); $(ls "$DIR"/ai_workforce-*.dump | wc -l) kept"
}

latest() { ls -1t "$DIR"/ai_workforce-*.dump 2>/dev/null | head -1; }

loop() {
  last=$(latest || true)
  if [ -z "$last" ] || [ $(( $(date +%s) - $(stat -c %Y "$last") )) -gt 90000 ]; then once || log "FAILED"; fi
  while true; do
    now=$(date -u +%s)
    next=$(date -u -d "$(date -u +%F) $HOUR:00" +%s)
    [ "$next" -le "$now" ] && next=$((next + 86400))
    sleep $((next - now))
    once || log "FAILED"
  done
}

# Restores the latest backup into a scratch database, checks every key table's row count lies
# between the counts taken just before and just after that dump, then drops the scratch copy.
restore_test() {
  file=$(latest)
  [ -n "$file" ] || { log "no backup to test"; exit 1; }
  base=${file%.dump}
  log "restoring $(basename "$file") into $SCRATCH"
  psql -d postgres -q -c "DROP DATABASE IF EXISTS $SCRATCH" -c "CREATE DATABASE $SCRATCH"
  trap 'psql -d postgres -q -c "DROP DATABASE IF EXISTS $SCRATCH"' EXIT
  pg_restore --exit-on-error --no-owner -d "$SCRATCH" "$file"
  bad=0
  counts "$SCRATCH" > /tmp/restored
  while read -r table restored; do
    before=$(awk -v t="$table" '$1 == t { print $2 }' "$base.before")
    after=$(awk -v t="$table" '$1 == t { print $2 }' "$base.after")
    lo=$(( before < after ? before : after )); hi=$(( before > after ? before : after ))
    if [ "$restored" -ge "$lo" ] && [ "$restored" -le "$hi" ]; then echo "  ok   $table $restored"; else echo "  FAIL $table restored $restored, expected $lo-$hi"; bad=1; fi
  done < /tmp/restored
  [ "$bad" -eq 0 ] && log "restore test passed" || { log "restore test FAILED"; exit 1; }
}

case "${1:-loop}" in
  loop) loop ;;
  once) once ;;
  restore-test) restore_test ;;
  *) echo "usage: $0 loop|once|restore-test"; exit 1 ;;
esac
