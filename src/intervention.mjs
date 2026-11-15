import {readFileSync,writeFileSync,appendFileSync,unlinkSync,renameSync,statSync,chownSync} from 'node:fs';
import {join} from 'node:path';

// One shared intervention lock, a hold switch and an append-only ledger in the
// private state folder. The watchdog, the memory guard, deploys and Codex/Claude
// repairs take the lock before refreshing or restarting anything, so two of
// them never act on the live reader at once (31 Oct 2026 Codex/Claude rule).
export const LOCK='intervention.lock',HOLD='watchdog-hold.json',LEDGER='interventions.ndjson';
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
// Files stay owned by the app user even when root writes them.
function own(dir,file){try{const s=statSync(dir);chownSync(file,s.uid,s.gid);}catch{}}

export function activeLock(dir,now=Date.now()){
 const lock=read(join(dir,LOCK));
 return lock&&Number.isFinite(lock.until)&&lock.until>now?lock:null;
}
// Exclusive create; an expired lock or one we already hold is replaced.
export function acquireLock(dir,owner,ms,reason='',now=Date.now()){
 const file=join(dir,LOCK),value=JSON.stringify({owner,reason:String(reason).slice(0,120),at:now,until:now+ms})+'\n';
 for(let i=0;i<2;i++){
  try{writeFileSync(file,value,{flag:'wx',mode:0o600});own(dir,file);return true;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const lock=read(file);
   if(lock&&lock.until>now&&lock.owner!==owner)return false;
   try{unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 }
 return false;
}
export function releaseLock(dir,owner){
 const file=join(dir,LOCK),lock=read(file);
 if(!lock||lock.owner!==owner)return false;
 unlinkSync(file);return true;
}

export function activeHold(dir,now=Date.now()){
 const hold=read(join(dir,HOLD));
 return hold&&Number.isFinite(hold.until)&&hold.until>now?hold:null;
}
export function setHold(dir,by,ms,reason='',now=Date.now()){
 const file=join(dir,HOLD),tmp=file+'.tmp';
 writeFileSync(tmp,JSON.stringify({by,reason:String(reason).slice(0,120),at:now,until:now+ms})+'\n',{mode:0o600});renameSync(tmp,file);own(dir,file);
}
export function clearHold(dir){try{unlinkSync(join(dir,HOLD));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

export function appendLedger(dir,entry,now=Date.now()){
 const file=join(dir,LEDGER);
 try{if(statSync(file).size>256*1024)renameSync(file,file+'.1');}catch(e){if(e.code!=='ENOENT')throw e;}
 appendFileSync(file,JSON.stringify({at:now,...entry})+'\n',{mode:0o600});own(dir,file);
}
export function readLedger(dir,sinceMs=7*24*3600000,now=Date.now()){
 let text='';try{text=readFileSync(join(dir,LEDGER),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 return text.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}})
  .filter(entry=>entry&&Number.isFinite(entry.at)&&now-entry.at<=sinceMs);
}
