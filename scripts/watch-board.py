import json, sys, time, urllib.request

# usage: watch-board.py <projectId> <label>
PID = sys.argv[1]
LABEL = sys.argv[2] if len(sys.argv) > 2 else "BOARD"
B = "http://127.0.0.1:3001"

def get(path):
    with urllib.request.urlopen(B + path, timeout=10) as r:
        return json.load(r)

def emit(msg):
    print(time.strftime("[%H:%M] ") + LABEL + " " + msg, flush=True)

prev = None
down_streak = 0
while True:
    # health first — the priority signal
    try:
        get("/api/projects")
        if down_streak:
            emit("RECOVERED: server 200 again")
        down_streak = 0
    except Exception as e:
        down_streak += 1
        emit("SERVER-DOWN (%dx): /api/projects unreachable (%s)" % (down_streak, type(e).__name__))
        time.sleep(30); continue
    try:
        iss = get("/api/issues?projectId=" + PID)
    except Exception:
        time.sleep(30); continue
    c = {"Backlog":0,"Todo":0,"In Progress":0,"In Review":0,"AI Reviewed":0,"Done":0,"Cancelled":0}
    for i in iss:
        n = i.get("statusName") or ""
        if n in c: c[n] += 1
    key = (c["In Progress"], c["In Review"], c["Done"])
    if key != prev:
        emit("InProgress=%d InReview=%d Done=%d Backlog=%d" % (c["In Progress"], c["In Review"], c["Done"], c["Backlog"]))
        prev = key
    time.sleep(75)
