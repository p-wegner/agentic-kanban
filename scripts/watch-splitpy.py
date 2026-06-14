import json, sys, time, urllib.request

PID = "2eb8ce04-cfdd-40ad-a121-e60ca9cabdc2"
B = "http://127.0.0.1:3001"

def get(path):
    with urllib.request.urlopen(B + path, timeout=10) as r:
        return json.load(r)

def emit(msg):
    print(time.strftime("[%H:%M] ") + msg, flush=True)

prev_done = -1
stall = 0
while True:
    try:
        iss = get("/api/issues?projectId=" + PID)
    except Exception as e:
        emit("SERVER-DOWN: /api/issues unreachable (%s)" % type(e).__name__)
        time.sleep(60); continue
    kids = [i for i in iss if isinstance(i.get("issueNumber"), int) and 2 <= i["issueNumber"] <= 17]
    total = len(kids)
    done = sum(1 for i in kids if (i.get("statusName") or "").lower() in ("done", "cancelled"))
    try:
        ws = get("/api/workspaces?projectId=" + PID)
        act = sum(1 for w in ws if w.get("status") in ("active", "reviewing", "fixing"))
    except Exception:
        act = -1
    if done != prev_done:
        emit("PROGRESS splitpy Done=%d/%d (activeBuilders=%s)" % (done, total, act))
        prev_done = done
        stall = 0
    if total and done >= total:
        emit("EPIC COMPLETE %d/%d" % (done, total))
        sys.exit(0)
    if act == 0 and total and done < total:
        stall += 1
        if stall >= 3:
            emit("STALL: 0 active builders, Done=%d/%d (~4.5min no builder)" % (done, total))
            stall = 0
    else:
        stall = 0
    time.sleep(90)
