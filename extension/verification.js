/* global chrome */
(function(root){
'use strict';
const PORTAL='https://rez.metu.edu.tr',CHALLENGE='https://challenges.cloudflare.com';
const PATHS=new Set(['/','/index.jsf','/view/home.jsf']);
function portalUrl(url){try{const u=new URL(url);return u.origin===PORTAL&&PATHS.has(u.pathname);}catch{return false;}}
function inspectPortal(){
  if(location.origin!=='https://rez.metu.edu.tr'||!['/','/index.jsf','/view/home.jsf'].includes(location.pathname))return {phase:'out_of_scope'};
  const body=String(document.body?.textContent||'').slice(0,16384);
  if(/access denied[.\s]+automated abuse,\s*scraping,\s*or malicious behavior/i.test(body))return {phase:'denied'};
  if(document.querySelector('input[type=password]'))return {phase:document.querySelector('input[name="cf-turnstile-response"]')?.value?'widget_ready':'login'};
  if(document.getElementById('form:facility_input'))return {phase:'signed_in'};
  if(document.querySelector('#challenge-form,#cf-challenge-running')||/^(just a moment|bir dakika)/i.test(document.title||''))return {phase:'challenge'};
  return {phase:'unknown'};
}
function inspectNativeGeometry(){
 if(location.origin!=='https://rez.metu.edu.tr'||!['/','/index.jsf','/view/home.jsf'].includes(location.pathname)||!document.querySelector('input[type=password]')||document.querySelector('input[name="cf-turnstile-response"]')?.value||document.visibilityState!=='visible'||devicePixelRatio!==1)return null;
 const stack=[document],frames=[];let visited=0;
 while(stack.length){if(++visited>3000)return null;const node=stack.pop();if(!node)continue;
  if(node.nodeType===1){
   if(node.tagName==='IFRAME'){try{if(new URL(node.src).origin==='https://challenges.cloudflare.com'){const r=node.getBoundingClientRect();if(r.width>0&&r.height>0)frames.push(r);}}catch{}}
   let shadow=node.shadowRoot;try{shadow=chrome.dom?.openOrClosedShadowRoot?.(node)||shadow;}catch{}if(shadow)stack.push(shadow);
  }
  for(const child of Array.from(node.children||[]))stack.push(child);
 }
 if(frames.length!==1)return null;
 const left=screenX+(outerWidth-innerWidth)/2,top=screenY+outerHeight-innerHeight,r=frames[0];
 return {viewport:{x:left,y:top,width:innerWidth,height:innerHeight},frame:{x:left+r.x,y:top+r.y,width:r.width,height:r.height}};
}
function create({chrome,readConfig,onReady=()=>{},nativeClick=async()=>false,nativeReady=async()=>({ready:true}),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const attempts=new Map(),watching=new Set();
  let budgetReady;
  function loadBudget(){
    if(!budgetReady)budgetReady=chrome.storage.session.get('verificationAttempts').then(({verificationAttempts=[]})=>{
      for(const entry of Array.isArray(verificationAttempts)?verificationAttempts.slice(-100):[]){
        if(Number.isInteger(entry?.tabId)&&typeof entry.documentId==='string'&&typeof entry.frameDocumentId==='string'){
          attempts.set(entry.tabId,{documentId:entry.documentId,frameDocumentId:entry.frameDocumentId,reported:entry.reported===true,nativeUsed:entry.nativeUsed===true});
        }
      }
    });
    return budgetReady;
  }
  const persistBudget=()=>chrome.storage.session.set({verificationAttempts:[...attempts].map(([tabId,entry])=>({tabId,...entry}))});
  function validSender(sender){
    try{return sender.id===chrome.runtime.id&&sender.frameId>0&&typeof sender.documentId==='string'
      &&Number.isInteger(sender.tab?.id)&&new URL(sender.url).origin===CHALLENGE&&portalUrl(sender.tab.url);}catch{return false;}
  }
  async function active(tabId){
    const config=await readConfig();
    const state=await chrome.storage.local.get(['paused','authBlocked','singleTabId','managedTabs','targetTabId']);
    if(state.paused!==false||state.authBlocked||config.maintenance||config.autoManage!==true||config.autoLogin!==true)return false;
    return config.singleTab===true?state.singleTabId===tabId
      :[config.readerTabId,state.targetTabId,...Object.values(state.managedTabs||{})].includes(tabId);
  }
  async function inspect(tabId){
    let timer;
    try{
      const result=await Promise.race([
        chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:inspectPortal}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('verification_timeout')),3000);})
      ]);
      if(result?.length!==1||result[0].frameId!==0||typeof result[0].documentId!=='string')return {phase:'unknown'};
      return {phase:result[0].result?.phase,documentId:result[0].documentId};
    }finally{clearTimeout(timer);}
  }
  async function save(outcome){await chrome.storage.local.set({verificationStatus:{at:new Date().toISOString(),outcome}});}
  async function preflight(sender){
    if(!validSender(sender))return {allowed:false};
    if(!await active(sender.tab.id))return {allowed:false,retryable:true};
    const tab=await chrome.tabs.get(sender.tab.id);
    if(!portalUrl(tab.url))return {allowed:false};
    const page=await inspect(tab.id);
    if(!['login','challenge'].includes(page.phase)||!page.documentId)return {allowed:false,...(page.phase==='unknown'?{retryable:true}:{})};
    await loadBudget();
    // Reserve at most one attempt for the top-level document, even if the
    // widget replaces its iframe. A new navigation gets a new document ID.
    if(attempts.get(tab.id)?.documentId===page.documentId)return {allowed:false};
    const native=(await readConfig()).nativeVerification===true;
    if(native){
      const readiness=await nativeReady();
      if(readiness?.ready!==true)return {allowed:false,retryable:readiness?.retryable===true};
    }
    if(!await active(tab.id))return {allowed:false};
    if(attempts.get(tab.id)?.documentId===page.documentId)return {allowed:false};
    attempts.set(tab.id,{documentId:page.documentId,frameDocumentId:sender.documentId,reported:false});
    if(attempts.size>100)attempts.delete(attempts.keys().next().value);
    await persistBudget();
    await save('attempt_authorized');
    return {allowed:true,native};
  }
  async function watch(tabId){
    if(watching.has(tabId))return;
    watching.add(tabId);let ready=false;
    try{
      for(let step=0;step<20;step++){
        if(!await active(tabId)){await save('cancelled');return;}
        const tab=await chrome.tabs.get(tabId);
        if(!portalUrl(tab.url)){await save('context_changed');return;}
        const page=await inspect(tabId);
        if(page.phase==='denied'){await save('denied');return;}
        if(page.phase==='signed_in'){await save('signed_in');void Promise.resolve().then(onReady).catch(()=>{});return;}
        if(page.phase==='widget_ready'&&!ready){ready=true;await save('widget_ready');void Promise.resolve().then(onReady).catch(()=>{});}
        await wait(750);
      }
      if(!ready)await save('not_confirmed');
    }catch{await save('verification_unavailable');}
    finally{watching.delete(tabId);}
  }
  async function performNative(position,sender){
    if(!validSender(sender)||!await active(sender.tab.id)||(await readConfig()).nativeVerification!==true)return {ok:false};
    await loadBudget();const attempt=attempts.get(sender.tab.id);
    if(!attempt||attempt.frameDocumentId!==sender.documentId||attempt.nativeUsed||attempt.reported)return {ok:false};
    if(!position||!Number.isFinite(position.x)||!Number.isFinite(position.y)||position.x<0||position.y<0||position.x>650||position.y>220)return {ok:false};
    attempt.nativeUsed=true;await persistBudget();
    const tab=await chrome.tabs.get(sender.tab.id);if(!portalUrl(tab.url)||!Number.isInteger(tab.windowId))return {ok:false};
    await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});
    const result=await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:'ISOLATED',func:inspectNativeGeometry});
    if(result?.length!==1||result[0].documentId!==attempt.documentId||!result[0].result)return {ok:false};
    const geometry=result[0].result;
    if(!await active(tab.id)||(await readConfig()).nativeVerification!==true)return {ok:false};
    return {ok:await nativeClick({requestId:attempt.documentId,expiresAt:Date.now()+5000,x:geometry.frame.x+position.x,y:geometry.frame.y+position.y,...geometry})===true};
  }
  function handleMessage(message,sender,reply){
    if(message?.type==='rez-verification:native'){void performNative(message.position,sender).then(reply).catch(()=>reply({ok:false}));return true;}
    if(message?.type==='rez-verification:preflight'){
      void preflight(sender).then(reply).catch(()=>reply({allowed:false}));return true;
    }
    if(message?.type!=='rez-verification:attempt')return false;
    void (async()=>{
      await loadBudget();
      const attempt=attempts.get(sender.tab?.id);
      if(!validSender(sender)||!['clicked','click_failed'].includes(message.outcome)||!attempt
        ||attempt.frameDocumentId!==sender.documentId||attempt.reported||!await active(sender.tab.id)){reply({ok:false});return;}
      attempt.reported=true;await persistBudget();await save(message.outcome);reply({ok:true});
      if(message.outcome==='clicked')void watch(sender.tab.id);
    })().catch(()=>reply({ok:false}));
    return true;
  }
  return {preflight,handleMessage,watch,validSender};
}
root.RezVerification={create,inspectPortal,inspectNativeGeometry};
})(globalThis);
