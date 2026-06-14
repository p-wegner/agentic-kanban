const BASE="http://localhost:3001"; const PID="e26fc324-1a62-45bb-8e01-61d37c323790"; const README=20;
const asArr=(x,k)=>Array.isArray(x)?x:(Array.isArray(x?.[k])?x[k]:[]);
try{
  const r=await fetch(`${BASE}/api/issues?projectId=${PID}`); const d=await r.json();
  const issues=asArr(d,'issues').filter(i=>i.projectId===PID);
  if(!issues.length){console.log('[kmp] poll-empty (transient?)'); process.exit(0);}
  const sr=await fetch(`${BASE}/api/projects/${PID}/statuses`); const st=asArr(await sr.json(),'statuses');
  const sName=Object.fromEntries(st.map(s=>[s.id,s.name]));
  const children=issues.filter(i=>i.issueNumber>=2&&i.issueNumber<=README);
  const done=children.filter(c=>['Done','Cancelled'].includes(sName[c.statusId])).length;
  const cnt={}; for(const c of children){const n=sName[c.statusId]||'?'; cnt[n]=(cnt[n]||0)+1;}
  const wr=await fetch(`${BASE}/api/workspaces?projectId=${PID}`); const wd=await wr.json();
  const ws=asArr(wd,'workspaces').filter(w=>w.status!=='closed');
  const codex=ws.filter(w=>w.provider==='codex');
  let alert='';
  if(codex.length) alert+=` ALERT:CODEX_WS=${codex.map(w=>w.id.slice(0,8)).join(',')}`;
  if(done===children.length && children.length) alert+=' ALL_CHILDREN_DONE';
  console.log(`[kmp] done=${done}/${children.length} cols=${JSON.stringify(cnt)} ws=${ws.length}(${ws.map(w=>w.provider).join('/')})${alert}`);
}catch(e){console.log('[kmp] poll-error '+String(e.message).slice(0,80));}
