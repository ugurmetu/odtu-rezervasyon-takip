/* global chrome */
(function(root){
'use strict';
// App budget, not a site limit: >=1s between site actions, <=64 per rolling
// minute, and a per-facility main-check interval. Facilities someone follows
// may be read again after 10s (the reader orders turns by deadline); others
// keep 30s. The total stays one action per second whatever the mix.
const FACILITY_MIN_MS=30000,PRIORITY_MIN_MS=10000,DIRECT_READ_MAX_ACTIONS=5;
const minIntervalMs=(config,id)=>config?.singleTab===true&&(config.priorityFacilities||[]).map(String).includes(String(id))?PRIORITY_MIN_MS:FACILITY_MIN_MS;
function create({chrome,now=()=>Date.now(),maxConcurrent=4,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const active=new Set();let pumping=false,reservation=Promise.resolve();
 // {ok} plus, when only the shared pace refused, how long until it allows the next action.
 function attempt(config,id,kind='calendar'){
  const work=reservation.then(async()=>{
   const at=now(),s=await chrome.storage.local.get(['paused','parallelRefreshLog','singleActionLog','facilityAttemptAt']);
   if(s.paused!==false||config.maintenance||!config.watchFacilities.includes(id))return {ok:false,waitMs:0};
   const single=config.singleTab===true;
   const log=((single?s.singleActionLog:null)||s.parallelRefreshLog||[]).filter(x=>Number.isFinite(x.at)&&at-x.at>=0&&at-x.at<60000);
   const attempts=s.facilityAttemptAt||{};
   // A direct read may make several site actions; keep room for all of them.
   const cap=kind==='calendar'&&single&&config.directRead===true?64-DIRECT_READ_MAX_ACTIONS+1:64;
   if(kind==='calendar'&&at-Number(attempts[id]||0)<minIntervalMs(config,id))return {ok:false,waitMs:0};
   const times=log.map(x=>x.at).sort((a,b)=>a-b);
   const waitMs=Math.max(log.length>=cap?times[log.length-cap]+60000-at:0,single&&times.length?times.at(-1)+1000-at:0);
   if(waitMs>0)return {ok:false,waitMs};
   await chrome.storage.local.set({[single?'singleActionLog':'parallelRefreshLog']:[...log,{id,at,...(single?{kind}:{})}],...(kind==='calendar'?{facilityAttemptAt:{...attempts,[id]:at}}:{})});return {ok:true,waitMs:0};
  });reservation=work.catch(()=>{});return work;
 }
 const reserve=async(config,id,kind='calendar')=>(await attempt(config,id,kind)).ok;
 // A read refused only by the 1-second pace waits the few hundred ms left here.
 // Returning to the next 1-second clock tick instead doubled the time between reads.
 async function reserveWithin(config,id,maxWaitMs=1500,kind='calendar'){
  for(let i=0;i<3;i++){
   const result=await attempt(config,id,kind);
   if(result.ok||!(result.waitMs>0&&result.waitMs<=maxWaitMs))return result.ok;
   await sleep(result.waitMs+5);
  }
  return false;
 }
 // The reservation stands for the first real site action of a direct read;
 // later actions are appended at the times the page actually made them.
 async function recordActions(id,actions){
  const work=reservation.then(async()=>{
   const times=(Array.isArray(actions)?actions:[]).map(Number).filter(Number.isFinite).slice(0,DIRECT_READ_MAX_ACTIONS);
   if(!times.length)return;
   const at=now(),s=await chrome.storage.local.get('singleActionLog');
   const log=(s.singleActionLog||[]).filter(x=>Number.isFinite(x.at)&&at-x.at<60000);
   const index=log.map((x,i)=>x.id===id&&x.kind==='calendar'?i:-1).filter(i=>i>=0).pop();
   if(index!==undefined)log[index]={...log[index],at:Math.max(log[index].at,times[0])};
   for(const time of times.slice(1))log.push({id,at:time,kind:'read'});
   await chrome.storage.local.set({singleActionLog:log});
  });reservation=work.catch(()=>{});return work;
 }
 async function pump(config,collect){
  if(pumping)return;pumping=true;
  try{
   const s=await chrome.storage.local.get(['paused','facilityAttemptAt','parallelDispatchAt']);if(s.paused!==false)return;
   const at=now(),attempts=s.facilityAttemptAt||{},dispatch=s.parallelDispatchAt||{};
   const ids=[...new Set(config.watchFacilities)].filter(id=>!active.has(id)&&at-Number(attempts[id]||0)>=30000)
    .sort((a,b)=>Number(dispatch[a]||0)-Number(dispatch[b]||0)||Number(a)-Number(b)).slice(0,Math.max(0,maxConcurrent-active.size));
   if(!ids.length)return;
   for(const id of ids){active.add(id);dispatch[id]=at;}
   await chrome.storage.local.set({parallelDispatchAt:dispatch});
   for(const id of ids)void Promise.resolve().then(()=>collect(id)).catch(()=>{}).finally(()=>active.delete(id));
  }finally{pumping=false;}
 }
 return {pump,reserve,reserveWithin,recordActions,reservePreparation:(config,id)=>reserve(config,id,'prepare'),reservePreparationWithin:(config,id)=>reserveWithin(config,id,1500,'prepare'),activeCount:()=>active.size};
}
root.RezParallel={create,minIntervalMs};
})(typeof globalThis==='undefined'?self:globalThis);
