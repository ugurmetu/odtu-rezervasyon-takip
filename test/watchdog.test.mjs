import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decide,noticeText,probeSite,LIMITS,deliverWatchdogNotice,publicationWindow} from '../src/watchdog.mjs';
import {acquireLock,releaseLock,activeLock,setHold,activeHold,clearHold,appendLedger,readLedger} from '../src/intervention.mjs';
import {createMemoryGuard} from '../src/memory-guard.mjs';

const T=Date.parse('2026-10-31T17:00:00Z'),MIN=60_000;
const up={active:'active',result:'success'},services={bot:up,browser:up,display:up};
const base=over=>({now:T,services,healthOk:true,reader:{phase:'ready'},lastReadAt:T-20_000,ledger:[],...over});
// Runs one minute of the watchdog the way the runner does: probe only on request.
const step=(input,site)=>{const d=decide(input);return d.action==='probe'?decide({...input,site,episode:d.episode}):d;};

test('a healthy reader is left alone and the site is not probed',()=>{
 assert.equal(decide(base()).action,'ok');
 assert.equal(decide(base({healthOk:false})).action,'ok','a brief health failure with recent reads is not a reason');
});
test('a METU outage causes no restart; when the site answers again Chrome is restarted, then both if needed',()=>{
 const stuck=base({reader:{phase:'network_wait'},lastReadAt:T-35*MIN});
 assert.equal(decide(stuck).action,'probe');
 const down=step(stuck,'down');assert.equal(down.action,'site_down');assert.equal(down.episode.since,T-35*MIN);
 const back=step({...stuck,now:T+MIN,episode:down.episode},'up');
 assert.equal(back.action,'restart_browser');assert.equal(back.reason,'site_up_no_reads');
 const ledger=[{at:T+MIN,actor:'watchdog',action:'restart_browser'}];
 assert.equal(step({...stuck,now:T+3*MIN,episode:back.episode,ledger},'up').action,'settling','waits 5 minutes after any intervention');
 const again=step({...stuck,now:T+7*MIN,episode:back.episode,ledger},'up');
 assert.equal(again.action,'restart_all','Chrome alone did not help: the bot is restarted as well');
});
test('a bot or Chrome start by anyone in the last 5 minutes (a deploy without a lock) is given time first',()=>{
 const stuck=base({reader:{phase:'network_wait'},lastReadAt:T-30*MIN,services:{...services,browser:{...up,startedAt:T-2*MIN}}});
 assert.equal(step(stuck,'up').action,'settling');
 assert.equal(step({...stuck,services:{...services,browser:{...up,startedAt:T-6*MIN}}},'up').action,'restart_browser');
});
test('verification, sign-in problems, a site refusal, a paused reader or blocked site are never restarted',()=>{
 for(const phase of ['waiting_verification','login_required','login_failed','credentials_missing','site_access_denied','site_rate_limited','paused']){
  const d=decide(base({reader:{phase},lastReadAt:T-20*MIN}));assert.equal(d.action,'owner',phase);
 }
 assert.equal(step(base({reader:{phase:'network_wait'},lastReadAt:T-20*MIN}),'blocked').action,'owner');
 assert.equal(decide(base({reader:{phase:'signing_in'},lastReadAt:T-5*MIN})).action,'ok','sign-in gets ten minutes');
});
test('a system stopped by hand, maintenance, a hold or another owner\'s lock is never touched',()=>{
 const stuck={reader:{phase:'network_wait'},lastReadAt:T-20*MIN};
 assert.equal(decide(base({...stuck,services:{...services,browser:{active:'inactive',result:'success'}}})).action,'hold');
 assert.equal(decide(base({...stuck,maintenance:true})).action,'hold');
 assert.equal(decide(base({...stuck,hold:{reason:'codex repair'}})).action,'hold');
 const locked=decide(base({...stuck,lock:{owner:'codex'}}));assert.equal(locked.action,'locked');assert.equal(locked.reason,'codex');
});
test('a crashed service is restarted even while METU is down; a hung bot restarts both',()=>{
 const crashed=decide(base({services:{...services,browser:{active:'failed',result:'exit-code'}},lastReadAt:T-10*MIN}));
 assert.equal(crashed.action,'restart_browser');
 assert.equal(step(base({healthOk:false,reader:null,lastReadAt:T-10*MIN}),'up').action,'restart_all');
});
test('at most 3 automatic restarts an hour and 6 a day across watchdog and memory guard; the owner hears once',()=>{
 const stuck=base({reader:{phase:'network_wait'},lastReadAt:T-90*MIN});
 const hour=[{at:T-50*MIN,actor:'watchdog',action:'restart_browser'},{at:T-40*MIN,actor:'memory-guard',action:'rotate_tab'},{at:T-30*MIN,actor:'watchdog',action:'restart_all'}];
 const first=step({...stuck,ledger:hour},'up');assert.equal(first.action,'limit');assert.equal(first.notify,true);
 assert.match(noticeText(first),/otomatik toparlama sınırı doldu/);
 assert.equal(step({...stuck,ledger:hour,episode:first.episode},'up').notify,false,'not repeated');
 const day=Array.from({length:6},(_,i)=>({at:T-(2+i*3)*3600_000,actor:'watchdog',action:'restart_browser'}));
 assert.equal(step({...stuck,ledger:day},'up').action,'limit');
 const manual=[{at:T-50*MIN,actor:'claude',action:'lock'},{at:T-40*MIN,actor:'codex',action:'lock'},{at:T-30*MIN,actor:'claude',action:'lock'}];
 assert.equal(step({...stuck,ledger:manual},'up').action,'restart_browser','manual work does not use the automatic budget');
});
test('recovery is declared only after new reads of several facilities, not because the site answers',()=>{
 const episode={since:T-40*MIN,actions:[{action:'restart_browser',at:T-2*MIN}]};
 assert.equal(decide(base({episode,readsSince:()=>2})).action,'verify');
 const done=decide(base({episode,readsSince:()=>LIMITS.recoveredFacilities}));
 assert.equal(done.action,'recovered');assert.equal(done.episode,null);
 assert.match(noticeText(done),/^🔧 Bekçi: okuma 19:20–20:00 arası durmuştu\. Site yanıt verince Chrome yeniden başlatıldı; yeni tesis okumaları geldi/);
 assert.equal(decide(base({episode:{since:T-40*MIN,actions:[]}})).action,'ok','no message when the watchdog did nothing');
});
test('the site probe tells an outage from a refusal',async()=>{
 assert.equal(await probeSite(async()=>({status:200})),'up');assert.equal(await probeSite(async()=>({status:302})),'up');
 assert.equal(await probeSite(async()=>({status:403})),'blocked');assert.equal(await probeSite(async()=>({status:429})),'blocked');
 assert.equal(await probeSite(async()=>({status:503})),'down');assert.equal(await probeSite(async()=>{throw new Error('timeout');}),'down');
});

test('an unavailable reservation route does not cause a restart just because its server answers',async()=>{
 const stuck=base({reader:{phase:'network_wait'},lastReadAt:T-20*MIN});
 for(const status of [400,401,404,410,500,503]){
  const site=await probeSite(async()=>({status}));
  assert.equal(site,'down',String(status));
  assert.equal(step(stuck,site).action,'site_down',String(status));
 }
});
test('the shared lock is exclusive, expires, and only its owner releases it; hold and ledger round-trip',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-intervention-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 assert.equal(acquireLock(dir,'watchdog',5*MIN,'site_up',T),true);
 assert.equal(acquireLock(dir,'codex',30*MIN,'repair',T+MIN),false);assert.equal(activeLock(dir,T+MIN).owner,'watchdog');
 assert.equal(releaseLock(dir,'codex'),false);
 assert.equal(acquireLock(dir,'codex',30*MIN,'repair',T+6*MIN),true,'an expired lock is replaced');
 assert.equal(releaseLock(dir,'codex'),true);assert.equal(activeLock(dir,T+7*MIN),null);
 setHold(dir,'ugur',60*MIN,'deploy',T);assert.equal(activeHold(dir,T+MIN).reason,'deploy');assert.equal(activeHold(dir,T+61*MIN),null);clearHold(dir);
 appendLedger(dir,{actor:'watchdog',action:'restart_browser'},T);appendLedger(dir,{actor:'memory-guard',action:'rotate_tab'},T-8*86400_000);
 assert.deepEqual(readLedger(dir,7*86400_000,T+MIN).map(e=>e.actor),['watchdog'],'older than a week is ignored');
});
test('the memory guard waits while another repair holds the lock and records its own tab refresh',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-memory-lock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let at=T;const file=join(dir,'config.json');writeFileSync(file,JSON.stringify({autoManage:true,singleTab:true,key:'synthetic-only'}));
 const store={state:{readerCapabilities:{memoryGuard:true},readerState:{phase:'ready',at:new Date(at).toISOString()}},engine:{health:{lastState:'ready'},pages:{}}};
 const guard=createMemoryGuard({store,configFiles:[file],stateFile:join(dir,'memory.json'),interventionDir:dir,now:()=>at,readUsage:()=>({current:1300*2**20,resident:1000*2**20}),token:()=>'1'.repeat(32)});
 const tick=()=>{at+=MIN;store.state.readerState.at=new Date(at).toISOString();return guard.tick();};
 acquireLock(dir,'codex',10*MIN,'repair',T);
 tick();assert.equal(tick().status,'waiting_lock');assert.equal(JSON.parse(readFileSync(file)).memoryRecycle,undefined);
 at=T+10*MIN;assert.equal(tick().status,'requested');
 assert.equal(activeLock(dir,at).owner,'memory-guard');assert.deepEqual(readLedger(dir,86400_000,at).map(e=>e.action),['rotate_tab']);
});

test('an earlier legacy limit notice survives episode resets and alternating publication waiting',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-notice-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'watchdog.json');let sent=0;
 let state={lastNotice:{action:'limit',at:T-10*MIN,result:'accepted'},episode:null};
 const limit={action:'limit',notify:true,episode:{since:T-30*MIN,actions:[]}};
 for(let i=0;i<12;i++){
  state=await deliverWatchdogNotice({file,state:{...state,episode:null},decision:i%2?limit:{action:'publication_wait'},now:T+i*MIN,readsSince:()=>0,send:async()=>{sent++;return'accepted';}});
  writeFileSync(file,JSON.stringify(state));state=JSON.parse(readFileSync(file));
 }
 assert.equal(sent,0);assert.equal(state.limitNotice.at,T-10*MIN);assert.equal(state.lastNotice.at,T-10*MIN);
});
test('notice reservation is durable before transmission and uncertainty is not retried after restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-notice-reserve-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'watchdog.json');let sent=0;
 const decision={action:'limit',notify:true,episode:{since:T-MIN,actions:[]}};
 const state=await deliverWatchdogNotice({file,state:{},decision,now:T,send:async()=>{
  sent++;const reserved=JSON.parse(readFileSync(file));assert.equal(reserved.limitNotice.at,T);assert.equal(reserved.lastNotice.result,'reserved');throw Error('API result lost');
 }});
 assert.equal(state.lastNotice.result,'uncertain');
 // Simulate termination before even the final result was written. The saved
 // reservation alone must prevent a second transmission in another process.
 const restarted=JSON.parse(readFileSync(file));assert.equal(restarted.lastNotice.result,'reserved');
 await deliverWatchdogNotice({file,state:restarted,decision,now:T+MIN,send:async()=>{sent++;return'accepted';}});
 assert.equal(sent,1);
});
test('only real reads from several facilities permit a limit notice for a later incident',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-notice-next-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'watchdog.json');let sent=0;
 const state={limitNotice:{at:T-30*MIN}},decision={action:'limit',notify:true,episode:{since:T-MIN,actions:[]}};
 for(const count of[0,1,4])await deliverWatchdogNotice({file,state,decision,now:T,readsSince:()=>count,send:async()=>{sent++;return'accepted';}});
 assert.equal(sent,0);
 const next=await deliverWatchdogNotice({file,state,decision,now:T,readsSince:()=>5,send:async()=>{sent++;return'accepted';}});assert.equal(sent,1);assert.equal(next.limitNotice.at,T);
});
function waitWindow(now=Date.parse('2026-11-01T18:00:00Z')){
 const state={readerPlan:{facilityIds:['17'],dates:['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08']},lastDiagnostic:'calendar_date_mismatch',engine:{health:{lastState:'calendar_unavailable',lastSeenAt:new Date(now).toISOString()},pages:{}}};
 return{rawWait:true,state,reader:{phase:'waiting_publication'},services,healthOk:true,now};
}
test('a short diagnostic transition reuses positive waiting evidence without extending its deadline',()=>{
 const f=waitWindow(),first=publicationWindow(f);assert.equal(first.waiting,true);
 const transition={...f,rawWait:false,previous:first.mark,now:f.now+MIN};transition.state.lastDiagnostic='unverified_response';
 assert.equal(publicationWindow(transition).waiting,true);assert.equal(publicationWindow(transition).mark.at,f.now);
 assert.equal(publicationWindow({...transition,now:f.now+120001}).waiting,false);
});
test('publication grace never masks login/network failures, crashes, stale evidence or actual new-week reads',()=>{
 const f=waitWindow(),previous=publicationWindow(f).mark;
 for(const phase of['waiting_verification','signing_in','network_wait','site_access_denied','paused'])assert.equal(publicationWindow({...f,previous,reader:{phase}}).waiting,false,phase);
 assert.equal(publicationWindow({...f,previous,services:{...services,bot:{active:'failed'}}}).waiting,false);
 assert.equal(publicationWindow({...f,previous,healthOk:false}).waiting,false);
 const transition={...f,rawWait:false,previous,now:f.now+MIN};
 transition.state.engine.pages.new={date:'2026-11-02',lastSuccessAt:new Date(f.now).toISOString()};assert.equal(publicationWindow(transition).waiting,false);
 delete transition.state.engine.pages.new;transition.state.engine.health.lastSeenAt=new Date(f.now-4*MIN).toISOString();assert.equal(publicationWindow(transition).waiting,false);
});
