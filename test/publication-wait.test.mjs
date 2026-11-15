import test from'node:test';import assert from'node:assert/strict';
import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{isPublicationWait}from'../src/publication-wait.mjs';import{coverageProblem}from'../src/coverage.mjs';import{decide}from'../src/watchdog.mjs';import{LocalStore}from'../src/store.mjs';
const at=s=>Date.parse('2026-11-01T'+s+':00+03:00');
function fixture(now=at('20:00')){
 const state={readerState:{phase:'preparing'},readerPlan:{facilityIds:['17','21'],dates:Array.from({length:7},(_,i)=>`2026-11-${String(i+2).padStart(2,'0')}`)},lastDiagnostic:'calendar_date_mismatch',engine:{health:{lastState:'calendar_unavailable',lastSeenAt:new Date(now).toISOString()},pages:{}}};return{state,now};
}
test('fresh future-plan date rejection waits through the entire Sunday evening, not a presumed publication hour',()=>{
 for(const time of['19:30','20:55','21:00','22:00','23:00','23:59'])assert.equal(isPublicationWait(fixture(at(time))),true,time);
 assert.equal(isPublicationWait(fixture(at('19:29'))),false);
 const monday=fixture(Date.parse('2026-11-02T00:00:00+03:00'));assert.equal(isPublicationWait(monday),false,'a current-week error is not hidden');
});
test('an empty list, missing observation, network error, CAPTCHA, or stale diagnostic is not classified as publication waiting',()=>{
 for(const change of[f=>f.state.engine.health.lastState='empty_unconfirmed',f=>f.state.lastDiagnostic='timeout',f=>f.state.readerState.phase='network_wait',f=>f.state.readerState.phase='waiting_verification',f=>f.state.engine.health.lastSeenAt=null,f=>f.state.engine.health.lastSeenAt=new Date(f.now-180001).toISOString(),f=>f.state.engine.health.lastSeenAt=new Date(f.now+1).toISOString()]){const f=fixture();change(f);assert.equal(isPublicationWait(f),false);}
});
test('only the exact next Monday–Sunday plan qualifies; a valid read ends waiting even for an empty full day',()=>{
 for(const change of[f=>f.state.readerPlan.dates.pop(),f=>f.state.readerPlan.dates[0]='2026-11-01',f=>f.state.readerPlan.facilityIds=[],f=>f.state.engine.pages.one={date:'2026-11-02',lastSuccessAt:new Date(f.now).toISOString(),slots:{}}]){const f=fixture();change(f);assert.equal(isPublicationWait(f),false);}
 const f=fixture();f.state.engine.pages.old={date:'2026-11-01',lastSuccessAt:new Date(f.now).toISOString()};assert.equal(isPublicationWait(f),true);
});
test('watchdog suppresses both restarts and false recovery/limit notices while ordinary collection attempts remain current',()=>{
 const f=fixture(),up={active:'active',result:'success'},input={now:f.now,services:{bot:up,browser:up,display:up},reader:{phase:'preparing'},healthOk:true,lastReadAt:f.now-3600000,publicationWait:isPublicationWait(f),episode:{since:f.now-3600000,actions:[{at:f.now-1200000,action:'restart_all'}],limitNotified:true}};
 const d=decide(input);assert.equal(d.action,'publication_wait');assert.equal(d.episode,null);assert.equal(d.notify,undefined);
 const crashed=decide({...input,services:{...input.services,browser:{active:'failed',result:'exit-code'}}});assert.equal(crashed.action,'restart_browser');
 assert.equal(decide({...input,healthOk:false,site:'up'}).action,'restart_all','a genuinely unresponsive bot retains repair');
 assert.equal(decide({...input,publicationWait:false}).action,'probe','stopped attempts are still investigated');
});
test('coverage stays silent and health exposes zero/future waiting, without changing records or faking success',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'rez-publication-')),old=Date.now;try{
  Date.now=()=>f.now;const store=new LocalStore(join(dir,'state.json'));Object.assign(store.state,{readerPlan:f.state.readerPlan,readerState:f.state.readerState,lastDiagnostic:f.state.lastDiagnostic});Object.assign(store.engine.health,f.state.engine.health);
  const before=JSON.stringify(store.engine.pages);assert.equal(coverageProblem(store,f.now),null);
  const h=store.status();assert.equal(h.reader.phase,'waiting_publication');assert.equal(h.reader.fresh,0);assert.equal(h.reader.total,14);assert.equal(JSON.stringify(store.engine.pages),before);
 }finally{Date.now=old;rmSync(dir,{recursive:true,force:true});}
});

test('a reconnecting future-only Sunday plan waits rather than restarting, with no invented fresh records',async()=>{
 const {publicationWindow}=await import('../src/watchdog.mjs'),f=fixture();f.state.readerState.phase='reconnecting';
 assert.equal(isPublicationWait(f),true);
 const up={active:'active'},input={rawWait:isPublicationWait(f),state:f.state,reader:{phase:'reconnecting'},services:{bot:up,browser:up,display:up},healthOk:true,now:f.now};
 assert.equal(publicationWindow(input).waiting,true);
 assert.equal(decide({...input,publicationWait:publicationWindow(input).waiting,lastReadAt:0}).action,'publication_wait');
 for(const reason of ['timeout','unverified_response','site_access_denied']){const q=fixture();q.state.readerState.phase='reconnecting';q.state.lastDiagnostic=reason;assert.equal(isPublicationWait(q),false,reason);}
 const seen=fixture();seen.state.readerState.phase='reconnecting';seen.state.engine.pages.new={date:'2026-11-02',lastSuccessAt:new Date(seen.now).toISOString()};assert.equal(isPublicationWait(seen),false);
 const old=fixture();old.state.readerState.phase='reconnecting';old.state.engine.health.lastSeenAt=new Date(old.now-180001).toISOString();assert.equal(isPublicationWait(old),false);
});
