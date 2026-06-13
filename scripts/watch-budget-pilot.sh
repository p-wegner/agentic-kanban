#!/usr/bin/env bash
# Background watcher for the budget-pilot drive.
# Every INTERVAL: force a monitor cycle (idempotent) + log the issue-status
# histogram and active-workspace count to a log file. A lightweight bridge +
# observability layer; real stall-recovery is done by the orchestrator reading
# this log. Stop with: kill the PID printed at launch.
set -u
BASE="http://localhost:3001"
PID="bfa9147b-d72a-4014-9a43-f136eaa3a2dd"
LOG="/tmp/budget_pilot_watch.log"
INTERVAL="${INTERVAL:-150}"

echo "watch start $(date -u +%H:%M:%S) interval=${INTERVAL}s" >> "$LOG"
while true; do
  # force a monitor cycle (belt-and-suspenders; autodrive also runs on its own)
  curl -s -X POST "$BASE/api/internal/monitor-run" -o /dev/null 2>/dev/null
  # snapshot
  curl -s "$BASE/api/issues?projectId=$PID" 2>/dev/null | python -c "
import json,sys,datetime
try:
    d=json.load(sys.stdin); issues=d if isinstance(d,list) else d.get('issues',[])
    st={'ec5179ec-5f26-4aca-9d52-5877790f6a46':'BL','06bcbe68-3cb5-4890-a5ac-817e186aee5f':'TODO','b3dbb42a-1e91-4ea6-ba84-307cfc8cef2b':'WIP','9418b882-06f9-4919-8562-7ce78cf46131':'REV','f942a499-2212-4029-b7d6-33e698c64427':'AIREV','28feeef1-eccb-41fc-9856-b73f8a1e132d':'DONE','a07f17ec-17ec-42f4-928d-390387d705c5':'CANC'}
    from collections import Counter
    c=Counter(st.get(i.get('statusId'),'?') for i in issues)
    order=['BL','TODO','WIP','REV','AIREV','DONE','CANC']
    hist=' '.join(f'{k}={c[k]}' for k in order if c[k])
    wip=[i.get('issueNumber') for i in issues if st.get(i.get('statusId'))=='WIP']
    rev=[i.get('issueNumber') for i in issues if st.get(i.get('statusId')) in ('REV','AIREV')]
    ts=datetime.datetime.utcnow().strftime('%H:%M:%S')
    print(f'{ts} {hist} | WIP={sorted(wip)} REV={sorted(rev)}')
except Exception as e:
    print('snapshot-err',e)
" >> "$LOG" 2>&1
  sleep "$INTERVAL"
done
