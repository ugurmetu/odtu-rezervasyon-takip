import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import '../recovery.js';
const {ensureManagedTab,ensureReady}=globalThis.RezRecovery;
const source=readFileSync(new URL('../recovery.js',import.meta.url),'utf8');
function setup(){
 const storage={},tabs=[],calls=[];
 const chrome={runtime:{id:'mjfddbpabfknhnpmhbdkfpjpefepomjn'},storage:{local:{get:async()=>({...storage}),set:async v=>Object.assign(storage,v)}},
 tabs:{query:async()=>tabs,create:async opt=>{calls.push(['create',opt]);const t={id:tabs.length+10,url:opt.url,status:'complete'};tabs.push(t);return t;},
 update:async(id,opt)=>{calls.push(['update',id,opt]);return {id,...opt};}},
 scripting:{executeScript:async ({func,args=[]})=>{calls.push(['inject',func.name]);return [{frameId:0,result:func.name==='inspectPage'?{page:'home',facilityId:'17',week:true,dates:['2026-10-28']}: {phase:'ready'}}];}}};
 return {chrome,storage,tabs,calls};
}
test('a missing managed tab is recreated inactive and pinned, then reused without duplicates',async()=>{
 const f=setup();const a=await ensureManagedTab(f.chrome,{},'17');
 const b=await ensureManagedTab(f.chrome,{},'17');
 assert.equal(a.id,b.id);assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 assert.equal(f.calls[0][1].active,false);assert.equal(f.calls[0][1].pinned,true);
 f.tabs.splice(0);f.storage.lastRecoveryActionAt=0;
 await ensureManagedTab(f.chrome,{},'17');assert.equal(f.calls.filter(x=>x[0]==='create').length,2);
});
test('a restored tagged tab is adopted even after its stored id changes',async()=>{
 const f=setup();f.storage.managedTabs={'21':55};f.tabs.push({id:99,url:'https://rez.metu.edu.tr/view/home.jsf?rez-takip=21'});
 assert.equal((await ensureManagedTab(f.chrome,{},'21')).id,99);assert.equal(f.calls.length,0);
});
test('manual verification and rejected credentials never trigger password submissions',async()=>{
 const f=setup();f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'login',verified:false}}];
 assert.equal((await ensureReady(f.chrome,{autoLogin:true},{id:1,status:'complete'},'17')).phase,'waiting_verification');
 f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'login',verified:true,invalid:true}}];
 assert.equal((await ensureReady(f.chrome,{autoLogin:true},{id:1,status:'complete'},'17')).phase,'login_failed');
 f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'login',verified:true}}];f.storage.authAttempts=2;
 assert.equal((await ensureReady(f.chrome,{autoLogin:true},{id:1,status:'complete'},'17')).phase,'login_failed');
 assert.equal(f.storage.authBlocked,true);
});
test('verified ready weekly view requires no preparation request',async()=>{
 const f=setup();const r=await ensureReady(f.chrome,{watchDates:['2026-10-28']},{id:1,status:'complete'},'17');
 assert.equal(r.phase,'ready');assert.deepEqual(f.calls,[['inject','inspectPage']]);
});
test('fresh reads in another view cannot keep a login tab in a redirect loop',async()=>{
 const f=setup();f.storage.lastSessionReadyAt=Date.now();f.storage.loginProbeAt={1:Date.now()-60000};
 f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'login',verified:false}}];
 assert.equal((await ensureReady(f.chrome,{autoLogin:true},{id:1,status:'complete'},'17')).phase,'waiting_verification');
 assert.equal(f.calls.filter(x=>x[0]==='update').length,0);
});
test('login submission refuses another host and never clicks a challenge',()=>{
 const context={location:{origin:'https://other.invalid',pathname:'/index.jsf'},document:{},globalThis:{}};
 runInNewContext(source,context);
 assert.equal(context.globalThis.RezRecovery.submitLogin({username:'test',password:'secret'}).phase,'reconnecting');
 let clicked=0;const fields={'form:user':{value:''},'form:button':{click(){clicked++;}}};
 context.location.origin='https://rez.metu.edu.tr';context.document={getElementById:id=>fields[id],querySelector:s=>s==='input[type=password]'?{}:s.startsWith('.cf-turnstile')?{}:null};
 assert.equal(context.globalThis.RezRecovery.submitLogin({username:'test',password:'secret'}).phase,'waiting_verification');
 assert.equal(clicked,0);assert.equal(fields['form:user'].value,'');
});

test('today clipped by the calendar DOM still satisfies setup readiness instead of looping gotoDate',()=>{
 class FixedDate extends Date{constructor(...args){super(...(args.length?args:['2026-10-28T00:01:00Z']));}}
 const context={globalThis:{},Date:FixedDate,location:{origin:'https://rez.metu.edu.tr',pathname:'/view/home.jsf'},
  window:{PrimeFaces:{widgets:{schedule:{id:'form:myschedule',jqc:{fullCalendar:()=>({format:()=> '2026-10-28'})}}}}},
  document:{body:{textContent:''},getElementById:()=>({value:'17'}),
   querySelector:s=>s==='input[type=password]'?null:{className:'fc-agendaWeek-view'},
   querySelectorAll:()=>['2026-10-29','2026-10-30'].map(date=>({getAttribute:()=>date}))}};
 runInNewContext(source,context);
 const result=context.globalThis.RezRecovery.inspectPage();assert.deepEqual(Array.from(result.dates),['2026-10-28','2026-10-29','2026-10-30']);
});

test('a normal expired session probes once, obtains local credentials once, submits once, then resumes the same weekly reader',async()=>{
 let now=Date.parse('2026-10-28T10:00:00Z');class ClockDate extends Date{static now(){return now;}}
 const storage={lastSessionReadyAt:now-10000},calls=[];let page={page:'login',verified:true};
 const chrome={runtime:{id:'test-extension'},storage:{local:{get:async()=>({...storage}),set:async v=>Object.assign(storage,v)}},tabs:{update:async(id,options)=>calls.push(['navigate',id,options.url])},scripting:{executeScript:async({func,args})=>{if(func.name==='inspectPage')return [{frameId:0,result:page}];calls.push(['submit',args[0]]);return [{frameId:0,result:{phase:'signing_in'}}];}}};
 const context={globalThis:{},Date:ClockDate,AbortSignal,fetch:async(url,options)=>{calls.push(['vault',url]);assert.equal(options.headers['X-Local-Key'],'test-key');return {ok:true,json:async()=>({username:'synthetic_user',password:'synthetic_password'})};}};
 runInNewContext(source,context);const ensure=context.globalThis.RezRecovery.ensureReady;
 const config={autoLogin:true,key:'test-key',watchDates:['2026-10-28']},tab={id:10,status:'complete'};
 assert.equal((await ensure(chrome,config,tab,'17')).phase,'reconnecting');assert.equal(calls.filter(c=>c[0]==='vault').length,0);
 now+=10000;assert.equal((await ensure(chrome,config,tab,'17')).phase,'signing_in');
 assert.equal(calls.filter(c=>c[0]==='vault').length,1);assert.equal(calls.filter(c=>c[0]==='submit').length,1);assert.equal(storage.authAttempts,1);
 storage.loginProbeAt[11]=now;now+=10000;assert.equal((await ensure(chrome,config,{id:11,status:'complete'},'21')).phase,'signing_in');assert.equal(calls.filter(c=>c[0]==='submit').length,1);
 page={page:'home',facilityId:'17',week:true,dates:['2026-10-28']};assert.equal((await ensure(chrome,config,tab,'17')).phase,'ready');
 assert.equal(calls.filter(c=>c[0]==='navigate').length,1);assert.equal(calls.filter(c=>c[0]==='vault').length,1);
});
test('a locked local credential store preserves the retryable session state without submitting a password',async()=>{
 const f=setup();f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'login',verified:true}}];
 const context={globalThis:{},AbortSignal,fetch:async()=>({ok:false,json:async()=>({error:'credentials_locked'})})};runInNewContext(source,context);
 assert.equal((await context.globalThis.RezRecovery.ensureReady(f.chrome,{autoLogin:true,key:'synthetic'}, {id:10,status:'complete'},'17')).phase,'credentials_locked');assert.equal(f.storage.authAttempts,undefined);
});

test('concurrent expired tabs share one login submission rather than sending the account password in parallel',async()=>{
 const storage={loginProbeAt:{10:1,11:1}},calls=[];
 const chrome={runtime:{id:'synthetic'},storage:{local:{get:async()=>({...storage}),set:async v=>Object.assign(storage,v)}},scripting:{executeScript:async({func})=>{if(func.name==='inspectPage')return [{frameId:0,result:{page:'login',verified:true}}];calls.push('submit');return [{frameId:0,result:{phase:'signing_in'}}];}}};
 const context={globalThis:{},AbortSignal,fetch:async()=>{calls.push('vault');await new Promise(r=>setImmediate(r));return{ok:true,json:async()=>({username:'synthetic',password:'synthetic_only'})};}};runInNewContext(source,context);
 const ensure=context.globalThis.RezRecovery.ensureReady,c={autoLogin:true,key:'synthetic'};
 const result=await Promise.all([10,11].map(id=>ensure(chrome,c,{id,status:'complete'},String(id))));
 assert.deepEqual(result.map(r=>r.phase),['signing_in','signing_in']);assert.equal(calls.filter(x=>x==='vault').length,1);assert.equal(calls.filter(x=>x==='submit').length,1);
});

test('preparing a newly discovered facility without a unit ID passes only Chrome-serializable arguments',async()=>{
 const f=setup();let prepareArgs;
 f.chrome.scripting.executeScript=async({func,args=[]})=>{
  if(args.some(v=>v===undefined))throw new TypeError('Value is unserializable');
  if(func.name==='inspectPage')return [{frameId:0,result:{page:'home',facilityId:'Seç',week:false,dates:[]}}];
  prepareArgs=args;return [{frameId:0,result:{phase:'preparing'}}];
 };
 const r=await ensureReady(f.chrome,{watchDates:['2026-10-28']},{id:1,status:'complete'},'2');
 assert.equal(r.phase,'preparing');assert.deepEqual(prepareArgs,['2',['2026-10-28'],null]);
});

test('all single-tab facilities reuse one existing home or login view and recreate only one if it closes',async()=>{
 const f=setup(),c={singleTab:true,reservePreparation:async()=>true,readerTabId:42};
 f.tabs.push({id:42,url:'https://rez.metu.edu.tr/view/home.jsf',status:'complete'});
 for(let id=1;id<=32;id++)assert.equal((await ensureManagedTab(f.chrome,c,String(id))).id,42);
 assert.equal(f.calls.length,0);f.tabs.splice(0);
 for(let id=1;id<=32;id++)await ensureManagedTab(f.chrome,c,String(id));
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 assert.equal(f.tabs[0].url,'https://rez.metu.edu.tr/view/home.jsf?rez-reader=1');
});
test('single-tab login redirect, calendar preparation and stale-session recovery all wait for the shared budget',async()=>{
 const f=setup();let phase={page:'home',facilityId:'1',week:true,dates:['2026-10-28']},granted=false;
 f.chrome.scripting.executeScript=async({func})=>{f.calls.push(['inject',func.name]);return [{frameId:0,result:func.name==='inspectPage'?phase:{phase:'preparing'}}];};
 const c={singleTab:true,watchDates:['2026-10-28'],reservePreparation:async()=>granted},tab={id:10,status:'complete'};
 assert.equal((await ensureReady(f.chrome,c,tab,'2')).phase,'preparing');assert.equal(f.calls.length,1);
 f.storage.sessionRecoveryTabId=10;
 assert.equal((await ensureReady(f.chrome,c,tab,'2')).phase,'reconnecting');assert.equal(f.calls.filter(x=>x[0]==='update').length,0);
 granted=true;await ensureReady(f.chrome,c,tab,'2');assert.equal(f.calls.filter(x=>x[0]==='update').length,1);assert.equal(f.storage.sessionRecoveryTabId,null);
});
test('pending normal site AJAX prevents changing facility while its prior response is still rendering',()=>{
 const context={globalThis:{},window:{PrimeFaces:{ajax:{Queue:{isEmpty:()=>false}}}},location:{origin:'https://rez.metu.edu.tr',pathname:'/view/home.jsf'},document:{body:{textContent:''},querySelector:()=>null}};
 runInNewContext(source,context);assert.equal(context.globalThis.RezRecovery.inspectPage().page,'busy');
});
test('a full-page browser check waits for a person instead of looking like a network fault',async()=>{
 const context={globalThis:{},location:{origin:'https://rez.metu.edu.tr',pathname:'/view/home.jsf'},
  document:{title:'Just a moment...',body:{textContent:''},getElementById:()=>null,querySelector:s=>s.includes('challenge')?{}:null}};
 runInNewContext(source,context);assert.equal(context.globalThis.RezRecovery.inspectPage().page,'challenge');
 const f=setup();f.chrome.scripting.executeScript=async()=>[{frameId:0,result:{page:'challenge'}}];
 assert.equal((await ensureReady(f.chrome,{singleTab:true,watchDates:['2026-10-28']},{id:1,status:'complete'},'2')).phase,'waiting_verification');
});
test('with the direct reader a signed-in home page is ready without a separate preparation action',async()=>{
 const f=setup();let reserved=0;
 f.chrome.scripting.executeScript=async({func})=>[{frameId:0,result:func.name==='inspectPage'?{page:'home',facilityId:'1',week:false,dates:[]}:{phase:'preparing'}}];
 const c={singleTab:true,directRead:true,watchDates:['2026-10-28'],reservePreparation:async()=>{reserved++;return true;}};
 assert.equal((await ensureReady(f.chrome,c,{id:1,status:'complete'},'2')).phase,'ready');assert.equal(reserved,0);
});

test('a remembered loading tab omitted by URL query is reused rather than duplicated',async()=>{
 const f=setup();f.storage.singleTabId=23;
 f.chrome.tabs.get=async id=>({id,status:'loading',url:'',pendingUrl:'https://rez.metu.edu.tr/view/home.jsf?rez-reader=1'});
 const tab=await ensureManagedTab(f.chrome,{singleTab:true,reservePreparation:async()=>true},'17');
 assert.equal(tab.id,23);assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
});
