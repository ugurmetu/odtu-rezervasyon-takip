/* global chrome */
(function(root){
'use strict';
const HOME='https://rez.metu.edu.tr/view/home.jsf';
const HOME_RE=/^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf(?:[?#]|$)/;
const LOGIN_RE=/^https:\/\/rez\.metu\.edu\.tr\/(?:index\.jsf(?:[?#]|$)|[?#]|$)/;
function inspectPage(){
  if(location.origin!=='https://rez.metu.edu.tr')return {page:'unexpected'};
  if(/access denied[.\s]+automated abuse,\s*scraping,\s*or malicious behavior/i.test(document.body?.textContent||''))return {page:'blocked'};
  // A full-page browser check is a human-verification wait, not a network fault.
  if(!document.getElementById?.('form:facility_input')&&!document.querySelector('input[type=password]')
    &&document.querySelector('#challenge-form,#cf-challenge-running,script[src*="/cdn-cgi/challenge-platform/"]')
    ||!document.getElementById?.('form:facility_input')&&/^(?:just a moment|bir dakika)/i.test(document.title||''))return {page:'challenge'};
  if(document.querySelector('input[type=password]')){
    const challenge=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],input[name="cf-turnstile-response"]');
    const response=document.querySelector('input[name="cf-turnstile-response"]');
    return {page:'login',verified:!challenge||Boolean(response?.value),invalid:/parola.*(?:hatalı|yanlış)|(?:invalid|incorrect)\s+(?:user|password|credentials)|giriş başarısız/i.test(document.body?.textContent||'')};
  }
  if(location.pathname!=='/view/home.jsf')return {page:'unexpected'};
  if(typeof window.PrimeFaces?.ajax?.Queue?.isEmpty==='function'&&!window.PrimeFaces.ajax.Queue.isEmpty())return {page:'busy'};
  const dates=Array.from(new Set(Array.from(document.querySelectorAll('.fc-view [data-date]')).map(e=>e.getAttribute('data-date')))).sort();
  // FullCalendar can omit today's data-date when its validRange starts at
  // the current time rather than midnight. The normal weekly AJAX response
  // can still contain today's sessions; do not loop gotoDate forever.
  const clock=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const today=`${clock.year}-${clock.month}-${clock.day}`;
  const tomorrow=new Date(Date.parse(`${today}T12:00:00Z`)+86400000).toISOString().slice(0,10);
  const schedule=Object.values(window.PrimeFaces?.widgets||{}).find(w=>w?.id==='form:myschedule');
  const anchor=schedule?.jqc?.fullCalendar?.('getDate')?.format?.('YYYY-MM-DD');
  if(anchor===today&&dates[0]===tomorrow)dates.unshift(today);
  return {page:'home',unitId:String(document.getElementById('form:unit_input')?.value||''),facilityId:String(document.getElementById('form:facility_input')?.value||''),
    week:/week/i.test(document.querySelector('.fc-view')?.className||''),
    dates};
}
function prepareHome(facilityId,dates,unitId){
  if(location.origin!=='https://rez.metu.edu.tr'||location.pathname!=='/view/home.jsf'||document.querySelector('input[type=password]'))return {phase:'reconnecting'};
  const widgets=Object.values(window.PrimeFaces?.widgets||{});
  if(unitId&&String(document.getElementById('form:unit_input')?.value||'')!==unitId){
    const unit=widgets.find(w=>w?.id==='form:unit');if(typeof unit?.selectValue!=='function')return {phase:'network_wait'};
    unit.selectValue(unitId);return {phase:'preparing'};
  }
  const chosen=String(document.getElementById('form:facility_input')?.value||'');
  if(chosen!==facilityId){
    const field=widgets.find(w=>w?.id==='form:facility');
    if(typeof field?.selectValue!=='function')return {phase:'network_wait'};
    field.selectValue(facilityId);return {phase:'preparing'};
  }
  const schedule=widgets.find(w=>w?.id==='form:myschedule');
  if(typeof schedule?.jqc?.fullCalendar!=='function')return {phase:'network_wait'};
  if(!/week/i.test(document.querySelector('.fc-view')?.className||'')){
    schedule.jqc.fullCalendar('changeView','agendaWeek');return {phase:'preparing'};
  }
  const enabled=new Set(Array.from(document.querySelectorAll('.fc-view [data-date]')).map(e=>e.getAttribute('data-date')));
  if(dates.some(date=>!enabled.has(date))){schedule.jqc.fullCalendar('gotoDate',dates[0]);return {phase:'preparing'};}
  document.title=(facilityId==='17'?'Baraka':facilityId==='21'?'Teknokent':'ODTÜ')+' · Rezervasyon Takip';
  return {phase:'ready'};
}
function submitLogin(credentials){
  if(location.origin!=='https://rez.metu.edu.tr'||!/^\/(?:index\.jsf)?$/.test(location.pathname))return {phase:'reconnecting'};
  const user=document.getElementById('form:user');
  const pass=document.querySelector('input[type=password]');
  const button=document.getElementById('form:button');
  if(!user||!pass||!button)return {phase:'network_wait'};
  const challenge=document.querySelector('.cf-turnstile,iframe[src*="challenges.cloudflare.com"],input[name="cf-turnstile-response"]');
  if(challenge&&!document.querySelector('input[name="cf-turnstile-response"]')?.value)return {phase:'waiting_verification'};
  for(const [field,value] of [[user,credentials.username],[pass,credentials.password]]){
    field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
  }
  button.click();return {phase:'signing_in'};
}
async function injected(chrome,tabId,func,args=[]){
  // A hung renderer must not hold the serial control queue forever.
  let timer;
  const call=chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func,args});
  const result=typeof setTimeout==='function'?await Promise.race([call,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('page_unavailable')),15000);})]).finally(()=>clearTimeout(timer)):await call;
  if(result?.length!==1||result[0].frameId!==0)throw new Error('page_unavailable');
  return result[0].result;
}
async function ensureManagedTab(chrome,config,facilityId){
  const tabs=await chrome.tabs.query({url:'https://rez.metu.edu.tr/*'});
  if(config.singleTab===true){
    const {singleTabId}=await chrome.storage.local.get('singleTabId');
    // URL-filtered queries can omit a newly created tab until navigation commits.
    if(Number.isInteger(singleTabId)&&!tabs.some(t=>t.id===singleTabId)&&typeof chrome.tabs.get==='function'){
      const loading=await chrome.tabs.get(singleTabId).catch(()=>null);if(loading)tabs.push(loading);
    }
    const eligible=t=>HOME_RE.test(t.pendingUrl||t.url||'')||LOGIN_RE.test(t.pendingUrl||t.url||'');
    let tab=tabs.find(t=>t.id===singleTabId&&eligible(t))||tabs.find(t=>t.id===config.readerTabId&&eligible(t));
    if(!tab)tab=tabs.find(t=>eligible(t)&&new URL(t.pendingUrl||t.url).searchParams.get('rez-reader')==='1');
    if(!tab&&tabs.filter(eligible).length===1)tab=tabs.find(eligible);
    if(!tab){
      if(!config.reservePreparation||!await config.reservePreparation())return null;
      tab=await chrome.tabs.create({url:HOME+'?rez-reader=1',active:false,pinned:false});
    }
    if(!Number.isInteger(tab?.id))throw new Error('page_unavailable');
    if(tab.autoDiscardable===true)await chrome.tabs.update(tab.id,{autoDiscardable:false});
    if(singleTabId!==tab.id)await chrome.storage.local.set({singleTabId:tab.id});
    return tab;
  }
  const {managedTabs={}}=await chrome.storage.local.get('managedTabs');
  let tab=tabs.find(t=>t.id===managedTabs[facilityId]&&(HOME_RE.test(t.url||'')||LOGIN_RE.test(t.url||'')));
  if(!tab)tab=tabs.find(t=>{try{return new URL(t.url).searchParams.get('rez-takip')===facilityId;}catch{return false;}});
  if(!tab){
    const {lastRecoveryActionAt=0}=await chrome.storage.local.get('lastRecoveryActionAt');
    if(Date.now()-lastRecoveryActionAt<15000)return null;
    await chrome.storage.local.set({lastRecoveryActionAt:Date.now()});
    tab=await chrome.tabs.create({url:`${HOME}?rez-takip=${facilityId}`,active:false,pinned:config.catalogDiscovery?false:true});
  }
  if(!Number.isInteger(tab?.id))throw new Error('page_unavailable');
  if(managedTabs[facilityId]!==tab.id)await chrome.storage.local.set({managedTabs:{...managedTabs,[facilityId]:tab.id}});
  return tab;
}
async function credentialRequest(chrome,config,path,method='GET',value){
  const response=await fetch(`http://127.0.0.1:8765/session/${path}`,{method,headers:{'X-Local-Key':config.key,
    'X-Rez-Extension':chrome.runtime.id,...(value?{'Content-Type':'application/json'}:{})},
    ...(value?{body:JSON.stringify(value)}:{}),signal:AbortSignal.timeout(7000),cache:'no-store'});
  const result=await response.json();
  if(!response.ok)throw new Error(['credentials_missing','credentials_locked'].includes(result.error)?result.error:'credentials_unavailable');
  return result;
}
async function ensureReady(chrome,config,tab,facilityId){
  if(!config.singleTab&&tab.status==='loading')return {phase:'preparing'};
  const page=await injected(chrome,tab.id,inspectPage);
  if(page?.page==='blocked')return {phase:'site_access_denied'};
  if(page?.page==='busy')return {phase:'preparing'};
  if(page?.page==='challenge')return {phase:'waiting_verification'};
  if(config.singleTab){
    const {sessionRecoveryTabId}=await chrome.storage.local.get('sessionRecoveryTabId');
    if(sessionRecoveryTabId===tab.id){
      if(page?.page==='home'){
        if(!config.reservePreparation||!await config.reservePreparation())return {phase:'reconnecting'};
        await chrome.tabs.update(tab.id,{url:HOME});
        await chrome.storage.local.set({sessionRecoveryTabId:null});
        return {phase:'reconnecting'};
      }
      if(page?.page==='login')await chrome.storage.local.set({sessionRecoveryTabId:null});
    }
  }
  if(page?.page==='login'){
    const {authAttempts=0,authSubmittedAt=0,authBlocked=false,lastSessionReadyAt=0,loginProbeAt={}}
      =await chrome.storage.local.get(['authAttempts','authSubmittedAt','authBlocked','lastSessionReadyAt','loginProbeAt']);
    // Probe a restored shared session only once per tab. Fresh AJAX from a
    // different old view must not cause an endless home → login redirect loop.
    if(lastSessionReadyAt&&!loginProbeAt[tab.id]){
      if(config.singleTab&&(!config.reservePreparation||!await config.reservePreparation()))return {phase:'preparing'};
      await chrome.storage.local.set({loginProbeAt:{...loginProbeAt,[tab.id]:Date.now()}});
      await chrome.tabs.update(tab.id,{url:`${HOME}?rez-takip=${facilityId}`});
      return {phase:'reconnecting'};
    }
    if(authBlocked||page.invalid)return {phase:'login_failed'};
    if(!page.verified)return {phase:'waiting_verification'};
    if(!config.autoLogin)return {phase:'credentials_missing'};
    if(authSubmittedAt&&Date.now()-authSubmittedAt<120000)return {phase:'signing_in'};
    if(authAttempts>=2){await chrome.storage.local.set({authBlocked:true});return {phase:'login_failed'};}
    if(config.singleTab&&(!config.reservePreparation||!await config.reservePreparation()))return {phase:'preparing'};
    let credentials;
    try{credentials=await credentialRequest(chrome,config,'credentials');}
    catch(error){return {phase:['credentials_missing','credentials_locked'].includes(error.message)?error.message:'credentials_unavailable'};}
    await chrome.storage.local.set({lastRecoveryActionAt:Date.now()});
    const result=await injected(chrome,tab.id,submitLogin,[credentials]);
    credentials=null;
    if(result?.phase==='signing_in')await chrome.storage.local.set({authAttempts:authAttempts+1,authSubmittedAt:Date.now()});
    return result;
  }
  if(page?.page!=='home')return {phase:'network_wait'};
  // The direct reader selects unit, facility, week and dates itself.
  if(config.singleTab&&config.directRead===true)return {phase:'ready'};
  if(page.facilityId===facilityId&&(!config.watchFacilityUnits?.[facilityId]||page.unitId===config.watchFacilityUnits[facilityId])&&page.week&&config.watchDates.every(date=>page.dates?.includes(date)))return {phase:'ready'};
  if(config.singleTab){
    if(!config.reservePreparation||!await config.reservePreparation())return {phase:'preparing'};
    return injected(chrome,tab.id,prepareHome,[facilityId,config.watchDates,config.watchFacilityUnits?.[facilityId]||null]);
  }
  const {lastRecoveryActionAt=0}=await chrome.storage.local.get('lastRecoveryActionAt');
  if(Date.now()-lastRecoveryActionAt<15000)return {phase:'preparing'};
  await chrome.storage.local.set({lastRecoveryActionAt:Date.now()});
  return injected(chrome,tab.id,prepareHome,[facilityId,config.watchDates,config.watchFacilityUnits?.[facilityId]||null]);
}
let controls=Promise.resolve();
const serial=fn=>(...args)=>{const task=controls.then(()=>fn(...args));controls=task.catch(()=>{});return task;};
root.RezRecovery={ensureManagedTab:serial(ensureManagedTab),ensureReady:serial(ensureReady),credentialRequest,inspectPage,prepareHome,submitLogin};
})(typeof globalThis==='undefined'?self:globalThis);
