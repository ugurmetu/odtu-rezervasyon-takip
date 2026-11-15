/* global chrome, RezVerificationCheckbox */
(function(){
'use strict';
if(!RezVerificationCheckbox.inScope(location))return;
let scheduled=false,stopped=false,enabled=false,retryTimer=null;const observers=new Map();
const controller=RezVerificationCheckbox.create({location,document,getComputedStyle:element=>getComputedStyle(element),isEnabled:()=>enabled,
  openShadow:element=>chrome.dom?.openOrClosedShadowRoot?.(element),
  nativeClick:async position=>(await chrome.runtime.sendMessage({type:'rez-verification:native',position}))?.ok===true,
  authorize:()=>chrome.runtime.sendMessage({type:'rez-verification:preflight'})});
function observe(target){
  if(observers.has(target)||observers.size>=100)return;
  const observer=new MutationObserver(schedule);
  observer.observe(target,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-checked','hidden','class','style']});
  observers.set(target,observer);
}
function clearRetry(){if(retryTimer!==null){clearTimeout(retryTimer);retryTimer=null;}}
function stop(){stopped=true;clearRetry();for(const observer of observers.values())observer.disconnect();observers.clear();}
function retryPermission(){
  if(stopped||!enabled||retryTimer!==null)return;
  retryTimer=setTimeout(()=>{retryTimer=null;schedule();},2000);
}
async function run(){
  scheduled=false;if(stopped||!enabled)return;
  try{
    const found=controller.find();for(const shadow of found.roots||[])observe(shadow);
    if(found.outcome!=='candidate')return;
    const result=await controller.attempt();
    if(result.attempted){stop();await chrome.runtime.sendMessage({type:'rez-verification:attempt',outcome:result.outcome});}
    else if(result.retryable===true)retryPermission();
  }catch{retryPermission();}
}
function schedule(){if(!scheduled&&!stopped&&enabled){scheduled=true;queueMicrotask(()=>void run());}}
function setPaused(paused){
  enabled=paused===false;
  if(enabled&&!stopped){observe(document);schedule();}
  else{clearRetry();for(const observer of observers.values())observer.disconnect();observers.clear();}
}
chrome.storage.onChanged.addListener(changes=>{if(changes.paused)setPaused(changes.paused.newValue);});
void chrome.storage.local.get('paused').then(({paused=true})=>setPaused(paused));
})();
