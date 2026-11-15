/* global chrome, RezRecovery */
(function(root){
'use strict';
function readCatalog(fresh=false){
 if(location.origin!=='https://rez.metu.edu.tr'||location.pathname!=='/view/home.jsf'||document.querySelector('input[type=password]'))return null;
 function fromDocument(doc){
 const select=doc.getElementById('form:facility_input');if(!select)return null;
 const unitSelect=doc.getElementById('form:unit_input');
 const units=Array.from(unitSelect?.options||[]).filter(o=>/^\d{1,4}$/.test(o.value)&&Number(o.value)>0&&o.textContent.trim()&&!/^(seç(?:iniz)?|select(?: one)?|choose)$/i.test(o.textContent.trim())).map(o=>({id:o.value,label:o.textContent.trim().slice(0,100)}));
 const unitId=units.some(u=>u.id===unitSelect?.value)?unitSelect.value:null;
 const selectedUnit=units.find(u=>u.id===unitId)?.label;
 const options=Array.from(select.options||[]);
 const facilities=options.filter(o=>/^\d{1,4}$/.test(o.value)&&Number(o.value)>0&&o.textContent.trim()&&!/^(seç(?:iniz)?|select(?: one)?|choose)$/i.test(o.textContent.trim())).map(o=>{
  const label=o.textContent.trim().slice(0,180),group=o.parentElement?.tagName==='OPTGROUP'?o.parentElement.label:null;
  const unit=selectedUnit||group||(/havuz|yüzme/i.test(label)?'Havuz Müdürlüğü':'Spor Müdürlüğü');
  return {id:o.value,label,unit,...(unitId?{unitId}:{}),...(o.disabled?{enabled:false}:{})};
 });
 if(facilities.length>200||units.length>30||new Set(facilities.map(f=>f.id)).size!==facilities.length)return null;
 // An empty error-rendered list cannot retire the registry.
 return {source:'official-facility-select',facilities,units,complete:facilities.length>0,unitId};
 }
 if(!fresh)return fromDocument(document);
 return (async()=>{
  const response=await fetch('/view/home.jsf',{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(response.status===403)return {phase:'site_access_denied'};
  if(response.status===429)return {phase:'site_rate_limited'};
  if(response.status===401||response.type==='opaqueredirect')return {phase:'login_required'};
  if(!response.ok)return null;
  const text=await response.text();if(text.length>2000000)return null;
  if(/access denied[.\s]+automated abuse,\s*scraping,\s*or malicious behavior/i.test(text.slice(0,16384)))return {phase:'site_access_denied'};
  const doc=new DOMParser().parseFromString(text,'text/html');
  if(/access denied[.\s]+automated abuse,\s*scraping,\s*or malicious behavior/i.test(doc.body?.textContent||''))return {phase:'site_access_denied'};
  if(doc.querySelector('input[type=password]'))return {phase:'login_required'};
  return fromDocument(doc);
 })();
}
function selectUnit(unitId){
 if(location.origin!=='https://rez.metu.edu.tr'||location.pathname!=='/view/home.jsf')return false;
 const field=document.getElementById('form:unit_input');if(!field)return false;if(field.value===unitId)return true;
 if(!Array.from(field.options||[]).some(o=>o.value===unitId&&!o.disabled))return false;
 const widget=Object.values(window.PrimeFaces?.widgets||{}).find(w=>w?.id==='form:unit');
 if(typeof widget?.selectValue!=='function')return false;widget.selectValue(unitId);return true;
}
async function inject(chrome,tabId,func,args=[]){
 let timer;try{
  const r=await Promise.race([chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func,args}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('catalog_timeout')),12000);})]);
  return r?.length===1&&r[0].frameId===0?r[0].result:null;
 }finally{clearTimeout(timer);}
}
async function run(chrome,config){
 if(!config.catalogDiscovery||config.maintenance)return null;
 const data=await chrome.storage.local.get(['catalogJob','catalogLastSweepAt','catalogTabId']);let job=data.catalogJob;
 if(!job&&Date.now()-Number(data.catalogLastSweepAt||0)<300000)return null;
 const tabs=await chrome.tabs.query({url:'https://rez.metu.edu.tr/*'});
 let tab=config.singleTab?await RezRecovery.ensureManagedTab(chrome,config,config.watchFacilities[0]):tabs.find(t=>{try{const u=new URL(t.url);return u.origin==='https://rez.metu.edu.tr'&&/^(?:\/view\/home\.jsf|\/index\.jsf|\/)$/.test(u.pathname)&&(t.id===(job?.tabId||data.catalogTabId)||u.searchParams.get('rez-discovery')==='1');}catch{return false;}});
 if(!job){
  if(config.singleTab&&!tab)return {pending:true};
  if(!tab)tab=await chrome.tabs.create({url:'https://rez.metu.edu.tr/view/home.jsf?rez-discovery=1',active:false,pinned:false});
  else if(!config.singleTab)await chrome.tabs.reload(tab.id);
  job={startedAt:Date.now(),tabId:tab.id,seen:[],...(config.singleTab?{fresh:true}:{})};await chrome.storage.local.set({catalogJob:job,catalogTabId:tab.id});return {pending:true};
 }
 if(!tab||tab.id!==job.tabId||Date.now()-job.startedAt>(config.singleTab?30000:900000)){await chrome.storage.local.set({catalogJob:null,catalogLastSweepAt:Date.now()});return {pending:true};}
 if(!config.singleTab&&tab.status==='loading')return {pending:true};
 if(config.singleTab&&job.nextUnit){
  if(!config.reservePreparation||!await config.reservePreparation())return {pending:true};
  if(await inject(chrome,tab.id,selectUnit,[job.nextUnit])){delete job.nextUnit;await chrome.storage.local.set({catalogJob:job});}
  return {pending:true};
 }
 const page=await inject(chrome,tab.id,RezRecovery.inspectPage);
 if(page?.page==='blocked')return {phase:'site_access_denied'};
 if(page?.page==='login'){
  const phase=await RezRecovery.ensureReady(chrome,config,tab,config.watchFacilities[0]);return {pending:true,phase:phase?.phase};
 }
 if(page?.page!=='home')return {pending:true};
 if(config.singleTab&&(!config.reservePreparation||!await config.reservePreparation()))return {pending:true};
 let catalog;
 try{catalog=await inject(chrome,tab.id,readCatalog,config.singleTab?[job.fresh===true]:[]);}
 catch{catalog=null;}
 if(catalog?.phase==='site_access_denied'||catalog?.phase==='site_rate_limited')return {phase:catalog.phase};
 if(catalog?.phase==='login_required'){
  await chrome.storage.local.set({sessionRecoveryTabId:tab.id,catalogJob:null,catalogLastSweepAt:Date.now()});
  return {phase:'reconnecting'};
 }
 if(!catalog){
  if(config.singleTab){await chrome.storage.local.set({catalogJob:null,catalogLastSweepAt:Date.now()});return {deferred:true};}
  return {pending:true};
 }
 const response=await fetch('http://127.0.0.1:8765/catalog/discover',{method:'POST',headers:{'X-Local-Key':config.key,'Content-Type':'application/json'},body:JSON.stringify(catalog),signal:AbortSignal.timeout(5000)});
 if(!response.ok){if(config.singleTab){await chrome.storage.local.set({catalogJob:null,catalogLastSweepAt:Date.now()});return {deferred:true};}return {pending:true};}
 if(config.singleTab)job.fresh=false;
 if(catalog.unitId&&!job.seen.includes(catalog.unitId))job.seen.push(catalog.unitId);
 const next=catalog.units.find(u=>!job.seen.includes(u.id));
 if(next){if(config.singleTab){job.nextUnit=next.id;await chrome.storage.local.set({catalogJob:job});return {pending:true};}if(await inject(chrome,tab.id,selectUnit,[next.id])){await chrome.storage.local.set({catalogJob:job});return {pending:true};}return {pending:true};}
 await chrome.storage.local.set({catalogJob:null,catalogLastSweepAt:Date.now()});return {complete:true};
}
root.RezCatalog={readCatalog,selectUnit,run};
})(typeof globalThis==='undefined'?self:globalThis);
