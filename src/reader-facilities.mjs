export const MAX_READER_FACILITIES=200;
export const BASE_FACILITIES=['17','21'];
export const isReaderFacility=f=>!!f&&/^\d{1,4}$/.test(String(f.id))&&!!f.label&&f.enabled!==false;
export const isTennisFacility=f=>isReaderFacility(f)&&/tenis.*kort|kort.*tenis/i.test(f.label||'');
export const readerSupportsAll=store=>store.state.readerCapabilities?.maxFacilities>=200&&store.state.readerCapabilities?.catalogDiscovery===true;
export const readerSupportsTennis=store=>store.state.readerCapabilities?.maxFacilities>=16;
export function canSelectFacility(store,id){const f=store.catalogFacility(id);return isReaderFacility(f)&&(BASE_FACILITIES.includes(String(id))||readerSupportsAll(store)||readerSupportsTennis(store)&&isTennisFacility(f));}
export function requestFacility(store,id,now=Date.now()){
 if(!canSelectFacility(store,id))return false;
 const requests=store.state.readerRequests||={};if(now-(requests[id]||0)<30000)return true;requests[id]=now;store.save();return true;
}
// Sunday 20:55-22:15 Istanbul covers both reported publication windows
// (around 21:00 or 22:00). Every facility gets a fair turn at the existing
// request budget; a clock time alone is never proof of publication.
export function inPublicationSweep(now=Date.now()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
  .formatToParts(new Date(now)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const sunday=new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`).getUTCDay()===0,time=`${parts.hour}:${parts.minute}`;
 return sunday&&time>='20:55'&&time<'22:15';
}
export function priorityFacilities({catalog=[],subscriptions=[],requests={},now=Date.now()}){
 if(inPublicationSweep(now))return [];
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
 const ids=new Set(subscriptions.filter(s=>s.active!==false&&(!s.date||s.date>=today)).map(s=>s.facilityId));
 for(const [id,at]of Object.entries(requests))if(now-at>=0&&now-at<15*60000)ids.add(id);
 return catalog.filter(f=>isReaderFacility(f)&&ids.has(f.id)).map(f=>f.id);
}
export function requestedFacilities({catalog=[],subscriptions=[],requests={},capabilities={},now=Date.now()}){
 if(capabilities.maxFacilities>=200&&capabilities.catalogDiscovery===true)return catalog.filter(isReaderFacility).map(f=>f.id).sort((a,b)=>Number(a)-Number(b)).slice(0,200);
 const base=BASE_FACILITIES.filter(id=>catalog.some(f=>f.id===id));if((capabilities.maxFacilities||0)<16)return base;
 const requested=new Set(priorityFacilities({catalog,subscriptions,requests,now}));
 return [...base,...catalog.filter(f=>!base.includes(f.id)&&isTennisFacility(f)&&requested.has(f.id)).map(f=>f.id).sort((a,b)=>Number(a)-Number(b))].slice(0,16);
}
export function facilityCadenceMs(store,id){
 const plan=store.state.readerPlan;if(!plan?.facilityIds?.includes(String(id)))return 240000;
 // A sequential selector needs preparation and a verified capture for every facility.
 // This is a freshness estimate, not a maximum notification-delay guarantee.
 // Followed facilities are read every ~25-30s; the rest share the remaining
 // budget (about two site actions per facility, at most 64 per minute).
 if(plan.scanMode==='single-tab')return (plan.priorityFacilities||[]).includes(String(id))?30000:Math.max(30000,plan.facilityIds.length*2500);
 if(plan.scanMode==='parallel')return Math.max(30000,Math.ceil(plan.facilityIds.length*60000/64));
 const ids=plan.facilityIds,priorities=(plan.priorityFacilities||[]).filter(p=>ids.includes(p));
 if(plan.scanMode==='priority'&&priorities.length&&priorities.length<ids.length){
  return priorities.includes(String(id))?Math.max(20000,(priorities.length+Math.ceil(priorities.length/3))*10000):(ids.length-priorities.length)*40000;
 }
 return Math.max(20000,ids.length*10000);
}
export const scheduleFreshMs=(store,id)=>Math.max(240000,facilityCadenceMs(store,id)*2+60000);

// The single selector reads one facility per second within its shared
// 64-actions/min budget. Every followed facility is passed on as equal: picking
// "the most followed" two made the rest wait 75-90s, and whoever follows a
// court counts as much as whoever follows a gym (29 Oct 2026 owner decision).
// The extension orders turns by deadline, so many followed facilities slow
// down evenly and the unfollowed ones still come round.
export function budgetFastLanes({priorityIds}){return priorityIds;}
