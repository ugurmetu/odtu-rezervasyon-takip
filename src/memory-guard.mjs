import {readFileSync,writeFileSync,renameSync,appendFileSync,statSync,lstatSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {activeLock,acquireLock,activeHold,appendLedger} from './intervention.mjs';

const MiB=1024*1024, LIMIT=1200*MiB;
export function readBrowserMemory(){
 const base='/sys/fs/cgroup/system.slice/odtu-rez-browser.service/';
 const current=Number(readFileSync(base+'memory.current','utf8'));
 const stats=Object.fromEntries(readFileSync(base+'memory.stat','utf8').trim().split('\n').map(line=>line.split(/\s+/)));
 const resident=Number(stats.anon)+Number(stats.shmem);
 if(!Number.isFinite(current)||!Number.isFinite(resident))throw new Error('memory_unavailable');
 return {current,resident};
}
export function normalizeMemoryRecycle(value){
 if(!value||!/^[a-f0-9]{32}$/.test(value.token)||!['rotated','failed'].includes(value.phase)
  ||!Number.isFinite(Date.parse(value.at)))throw new Error('invalid memory recycle');
 return {token:value.token,phase:value.phase,at:new Date(value.at).toISOString()};
}
function load(file,fallback){try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function save(file,value){
 const tmp=file+'.memory.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);
}
export function createMemoryGuard({store,configFiles,stateFile,historyFile,interventionDir=null,now=()=>Date.now(),readUsage=readBrowserMemory,token=()=>randomBytes(16).toString('hex')}){
 const state=load(stateFile,{highSamples:0,requests:[],pending:null,lastRequestAt:0,status:'observing'});
 function tick(){
  const at=now(),usage=readUsage();
  if(!Number.isFinite(usage.current)||!Number.isFinite(usage.resident)||usage.current<0||usage.resident<0)throw new Error('memory_unavailable');
  const reader=store.state.readerState,ack=store.state.readerMemoryRecycle;
  const fresh=reader?.phase==='ready'&&at-Date.parse(reader.at)>=0&&at-Date.parse(reader.at)<=15000&&store.engine?.health?.lastState!=='paused';
  const high=usage.current>=LIMIT&&usage.resident>=900*MiB;
  state.requests=state.requests.filter(t=>at-t<6*3600000);
  if(state.pending){
   const p=state.pending;
   if(ack?.token===p.token&&ack.phase==='failed'){state.status='failed';state.pending=null;}
   else if(ack?.token===p.token&&ack.phase==='rotated'&&fresh&&Date.parse(reader.at)>Date.parse(ack.at)){
    const pages=Object.values(store.engine?.pages||{});
    if(pages.some(page=>Date.parse(page.lastSuccessAt)>Date.parse(ack.at))){
     if(!high){state.status='recovered';state.lastRecoveredAt=at;state.pending=null;}
     else state.status='waiting_memory_drop';
    }
   }
   if(state.pending&&at-p.at>300000){state.status='timeout';state.pending=null;}
  }
  state.highSamples=high?state.highSamples+1:0;
  if(!state.pending&&state.highSamples>=2&&at-state.lastRequestAt>=900000){
   if(!fresh||store.state.readerCapabilities?.memoryGuard!==true)state.status='waiting_safe_reader';
   else if(state.requests.length>=3)state.status='reset_limit_reached';
   // Shared with the watchdog, deploys and repairs: never two interventions at once.
   else if(interventionDir&&(activeHold(interventionDir,at)||(l=>l&&l.owner!=='memory-guard')(activeLock(interventionDir,at))))state.status='waiting_lock';
   else if(interventionDir&&!acquireLock(interventionDir,'memory-guard',300000,'memory',at))state.status='waiting_lock';
   else{
    const request={token:token(),requestedAt:new Date(at).toISOString()};
    if(!/^[a-f0-9]{32}$/.test(request.token))throw new Error('invalid memory request');
    // This runs in the same Node event loop as date-plan writes: read/merge/
    // rename is synchronous, so a new date plan or secret cannot be overwritten.
    const eligible=configFiles.filter(file=>{
     if(lstatSync(file).isSymbolicLink())throw new Error('reader_config_symlink');
     const c=load(file,null);return c?.autoManage===true&&c.singleTab===true&&!c.maintenance;
    });
    if(eligible.length!==1)state.status='waiting_safe_reader';
    else{
     const config=load(eligible[0],null);save(eligible[0],{...config,memoryRecycle:request});
     state.pending={token:request.token,at};state.lastRequestAt=at;state.requests.push(at);state.status='requested';
     if(interventionDir)appendLedger(interventionDir,{actor:'memory-guard',action:'rotate_tab',reason:'memory'},at);
    }
   }
  }
  state.lastSample={at:new Date(at).toISOString(),currentMiB:Math.round(usage.current/MiB),residentMiB:Math.round(usage.resident/MiB)};
  save(stateFile,state);
  if(historyFile){
   try{if(statSync(historyFile).size>1024*1024)renameSync(historyFile,historyFile+'.1');}catch(e){if(e.code!=='ENOENT')throw e;}
   appendFileSync(historyFile,JSON.stringify({...state.lastSample,status:state.status,highSamples:state.highSamples,resetsInSixHours:state.requests.length})+'\n',{mode:0o600});
  }
  return structuredClone(state);
 }
 return {tick};
}
