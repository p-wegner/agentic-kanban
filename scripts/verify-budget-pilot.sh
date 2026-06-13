#!/usr/bin/env bash
# Close-out verification for the budget-pilot drive:
#   1) board says all 16 children terminal (Done/Cancelled)
#   2) master actually advanced (git log, not just board flags) — pitfall_silent_merge_loss
#   3) clean checkout builds green (pnpm install && pnpm build)
set -u
BASE="http://localhost:3001"
PID="bfa9147b-d72a-4014-9a43-f136eaa3a2dd"
REPO="/c/projects/budget-pilot"

echo "=== (1) board status histogram ==="
curl -s "$BASE/api/issues?projectId=$PID" | python -c "
import json,sys
from collections import Counter
st={'ec5179ec-5f26-4aca-9d52-5877790f6a46':'BL','06bcbe68-3cb5-4890-a5ac-817e186aee5f':'TODO','b3dbb42a-1e91-4ea6-ba84-307cfc8cef2b':'WIP','9418b882-06f9-4919-8562-7ce78cf46131':'REV','f942a499-2212-4029-b7d6-33e698c64427':'AIREV','28feeef1-eccb-41fc-9856-b73f8a1e132d':'DONE','a07f17ec-17ec-42f4-928d-390387d705c5':'CANC'}
d=json.load(sys.stdin); iss=d if isinstance(d,list) else d.get('issues',[])
c=Counter(st.get(i.get('statusId'),'?') for i in iss)
for i in sorted(iss,key=lambda x:x.get('issueNumber',0)):
    print(' #%-3s %-6s %s'%(i.get('issueNumber'),st.get(i.get('statusId'),'?'),i.get('title','')[:46]))
print('HIST:',dict(c))
term=c['DONE']+c['CANC']
print('TERMINAL %d/%d'%(term,len(iss)))
"
echo
echo "=== (2) master git log (top 20) ==="
git -C "$REPO" log master --oneline -20 2>/dev/null
echo "--- file tree on master (src) ---"
git -C "$REPO" ls-tree -r --name-only master 2>/dev/null | grep '^src/features/' | sed 's|/[^/]*$||' | sort -u
echo
echo "=== (3) clean build on master ==="
git -C "$REPO" checkout master -q 2>/dev/null
( cd "$REPO" && pnpm install --silent 2>&1 | tail -3 && echo "--- build ---" && pnpm build 2>&1 | tail -15 )
echo "BUILD EXIT: $?"
