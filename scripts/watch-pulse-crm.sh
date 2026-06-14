#!/usr/bin/env bash
# Watcher for PulseCRM: each cycle force a monitor run (tier-1 cascade, respects WIP)
# + ONE start-next (bridges the #782 fan-in for tier-2/integration; self-caps at
# wipLimit=5, so no over-launch) + log histogram. Merges land via the 30s orchestrator.
set -u
BASE="http://localhost:3001"; PID="5e10429c-c3a5-4e41-8869-4d86d267d2a5"; LOG="/tmp/pulse_watch.log"; INTERVAL="${INTERVAL:-90}"
echo "watch v2 start $(date -u +%H:%M:%S)" >> "$LOG"
while true; do
  curl -s -X POST "$BASE/api/internal/monitor-run" -o /dev/null 2>/dev/null
  curl -s -X POST "$BASE/api/projects/$PID/dependency-waves/start-next" -o /dev/null 2>/dev/null
  curl -s "$BASE/api/issues?projectId=$PID" 2>/dev/null | python -c "
import json,sys,datetime
from collections import Counter
try:
    d=json.load(sys.stdin); iss=d if isinstance(d,list) else d.get('issues',[])
    c=Counter(i.get('statusName') or '?' for i in iss)
    order=['Backlog','Todo','In Progress','In Review','AI Reviewed','Done','Cancelled']
    hist=' '.join(f'{k.replace(\" \",\"\")}={c[k]}' for k in order if c[k])
    print(datetime.datetime.utcnow().strftime('%H:%M:%S'),hist)
except Exception as e: print('err',e)
" >> "$LOG" 2>&1
  sleep "$INTERVAL"
done
