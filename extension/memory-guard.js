/* global chrome */
(function(root){
'use strict';
const HOME='https://rez.metu.edu.tr/view/home.jsf';
const valid=r=>r&&/^[a-f0-9]{32}$/.test(r.token)&&Number.isFinite(Date.parse(r.requestedAt));
function create({chrome,now=()=>Date.now(),inspect,report}){
 let busy=false;
 async function acknowledge(config,record){
  if(record.reported)return;
  try{await report(config,record);record.reported=true;await chrome.storage.local.set({memoryRecycle:record});}catch{}
 }
 async function maybeRotate(config){
  const request=config.memoryRecycle;
  if(!valid(request)||!config.singleTab||!config.autoManage||config.maintenance)return false;
  if(busy)return true;
  busy=true;
  try{
   const state=await chrome.storage.local.get(['paused','singleTabId','memoryRecycle']);
   if(state.paused!==false)return false;
   let record=state.memoryRecycle;
   const same=record?.token===request.token;
   if(same&&['rotated','failed'].includes(record.phase)){
    // Retrying only the local acknowledgement is safe after a lost response.
    await acknowledge(config,record);return false;
   }
   const age=now()-Date.parse(request.requestedAt);
   if(age<0||age>300000)return false;
   if(!same){
    if(record&&now()-Date.parse(record.at)<900000)return false;
   }
   const tabs=await chrome.tabs.query({});
   const tagged=t=>{try{const u=new URL(t.pendingUrl||t.url);return u.origin==='https://rez.metu.edu.tr'&&u.pathname==='/view/home.jsf'&&u.searchParams.get('rez-memory')===request.token;}catch{return false;}};
   let replacement=tabs.find(tagged);
   const oldId=same?record.oldId:state.singleTabId;
   const old=tabs.find(t=>t.id===oldId);
   if(!same){
    if(!Number.isInteger(oldId)||!old||!/^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf(?:[?#]|$)/.test(old.url||''))return false;
    // Never use memory pressure as a reason to retry a login or challenge.
    let timer;
    const page=await Promise.race([inspect(oldId),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),15000);})]).catch(()=>null).finally(()=>clearTimeout(timer));
    if(page?.page!=='home')return false;
    if(!config.reserveMemoryPreparation||!await config.reserveMemoryPreparation())return false;
    if((await chrome.storage.local.get('paused')).paused!==false)return false;
    record={token:request.token,requestedAt:request.requestedAt,at:new Date(now()).toISOString(),phase:'starting',oldId};
    await chrome.storage.local.set({memoryRecycle:record});
   }
   try{
    if((await chrome.storage.local.get('paused')).paused!==false)return false;
    if(!replacement)replacement=await chrome.tabs.create({url:HOME+'?rez-reader=1&rez-memory='+request.token,active:false,pinned:false});
    if(!Number.isInteger(replacement?.id)||replacement.id===oldId)throw new Error('replacement_unavailable');
    await chrome.tabs.update(replacement.id,{autoDiscardable:false});
    // Create and remember the replacement BEFORE closing the old last tab.
    await chrome.storage.local.set({singleTabId:replacement.id,singleReaderJob:null,catalogJob:null,memoryRecycle:{...record,newId:replacement.id}});
    if(old&&/^https:\/\/rez\.metu\.edu\.tr\//.test(old.url||old.pendingUrl||''))await chrome.tabs.remove(oldId);
    record={...record,newId:replacement.id,phase:'rotated',at:new Date(now()).toISOString()};
   }catch{
    // A failure consumes this request; don't create an endless reload loop.
    record={...record,phase:'failed',at:new Date(now()).toISOString()};
   }
   await chrome.storage.local.set({memoryRecycle:record});
   await acknowledge(config,record);
   return true;
  }finally{busy=false;}
 }
 return {maybeRotate};
}
root.RezMemoryGuard={create};
})(typeof globalThis==='undefined'?self:globalThis);
