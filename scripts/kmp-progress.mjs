const BASE="http://localhost:3001"; const PID="e26fc324-1a62-45bb-8e01-61d37c323790";
const META=1, README=20;
const r=await fetch(`${BASE}/api/issues?projectId=${PID}`); const d=await r.json();
const issues=(d.issues||d).filter(i=>i.projectId===PID);
const byNum=Object.fromEntries(issues.map(i=>[i.issueNumber,i]));
// status name via statuses
const sr=await fetch(`${BASE}/api/projects/${PID}/statuses`); const st=await sr.json();
const sName=Object.fromEntries(st.map(s=>[s.id,s.name]));
const children=issues.filter(i=>i.issueNumber>=2&&i.issueNumber<=README);
const cnt={};
for(const c of children){const n=sName[c.statusId]||'?'; cnt[n]=(cnt[n]||0)+1;}
const done=children.filter(c=>['Done','Cancelled'].includes(sName[c.statusId])).length;
const wr=await fetch(`${BASE}/api/workspaces?projectId=${PID}`); const wd=await wr.json();
const ws=(wd.workspaces||wd).filter(w=>w.status!=='closed');
const active=ws.filter(w=>['active','running','fixing','reviewing'].includes(w.status));
console.log(`children Done/Cancelled: ${done}/${children.length}  cols=${JSON.stringify(cnt)}`);
console.log(`open workspaces: ${ws.length}  active: ${active.length}  providers=${[...new Set(ws.map(w=>w.provider))].join(',')}`);
const meta=byNum[META]; console.log(`meta #1 status=${sName[meta.statusId]}`);
for(const w of ws){console.log(`  ws ${w.id.slice(0,8)} ${w.branch?.replace('feature/ak-','#').split('-')[0]||''} status=${w.status} prov=${w.provider}`);}
