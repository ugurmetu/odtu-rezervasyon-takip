/* global chrome */
(function(root){
'use strict';
// One managed tab reads facilities one after another. A completed read starts
// the next one at once (the shared budget still spaces site actions), so the
// order is not tied to the 1-second clock tick. Followed facilities go first.
const MAX_READS_PER_PUMP=24,OTHER_LIMIT_MS=85000,READ_STEP_MS=1000;
function create({chrome,now=()=>Date.now(),readConfig=null,beforeTurn=null}){
 let busy=false;
 async function pump(initialConfig,collect){
  if(busy||initialConfig.maintenance||!initialConfig.autoManage)return;
  busy=true;
  try{
   let config=initialConfig;
   for(let turn=0;turn<MAX_READS_PER_PUMP;turn++){
    if(turn&&readConfig){try{config=await readConfig();}catch{return;}if(config.maintenance||!config.autoManage)return;}
    if(beforeTurn&&await beforeTurn(config)===false)return;
    const s=await chrome.storage.local.get(['paused','singleReaderJob','singleDispatchAt','facilityAttemptAt']);
    if(s.paused!==false)return;
    const ids=[...new Set(config.watchFacilities||[])];if(!ids.length)return;
    const priority=new Set((config.priorityFacilities||[]).map(String).filter(id=>ids.includes(id)));
    const minMs=id=>root.RezParallel?.minIntervalMs?root.RezParallel.minIntervalMs(config,id):30000;
    const at=now(),dispatch=s.singleDispatchAt||{},attempts=s.facilityAttemptAt||{};
    let job=s.singleReaderJob;
    if(job&&(!ids.includes(job.id)||at-job.since>90000))job=null;
    if(!job){
     // Two lanes in one budget. Followed facilities (anyone's choice counts the
     // same) take turns oldest first. The others get an evenly spaced share so
     // each is read within ~85s, never in a burst that holds the followed ones
     // up. With nothing followed this is a plain round of every facility.
     const last=id=>Math.max(Number(attempts[id]||0),Number(dispatch[id]||0));
     const oldest=list=>list.sort((a,b)=>last(a)-last(b)||Number(a)-Number(b))[0];
     const eligible=ids.filter(id=>at-Number(attempts[id]||0)>=minMs(id));
     const followed=eligible.filter(id=>priority.has(id)),others=eligible.filter(id=>!priority.has(id));
     const unfollowed=ids.filter(id=>!priority.has(id));
     // A turn starts on a ~1s step, so ask one step early to keep the spacing.
     // After a restart every followed facility is read once before the rest.
     const lastOther=Math.max(0,...unfollowed.map(last));
     const otherDue=unfollowed.length>0&&(lastOther?at-lastOther>=OTHER_LIMIT_MS/unfollowed.length-READ_STEP_MS:![...priority].some(id=>!last(id)));
     const id=(otherDue&&others.length?oldest(others):oldest(followed))||oldest(others);
     if(!id)return;job={id,since:at};dispatch[id]=at;
     await chrome.storage.local.set({singleReaderJob:job,singleDispatchAt:dispatch});
    }
    await collect(job.id);
    const after=await chrome.storage.local.get(['facilityAttemptAt','paused']);
    const finished=Number(after.facilityAttemptAt?.[job.id]||0)>=job.since;
    if(after.paused!==false||finished)await chrome.storage.local.set({singleReaderJob:null});
    // Preparation, sign-in and budget waits resume on the next clock tick.
    if(after.paused!==false||!finished||!readConfig)return;
   }
  }finally{busy=false;}
 }
 return {pump};
}
root.RezSingle={create};
})(typeof globalThis==='undefined'?self:globalThis);
