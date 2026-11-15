import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../verification.js',import.meta.url),'utf8');
function fixture({phase='login',nativeReady=async()=>({ready:true})}={}){
  const state={paused:false,singleTabId:9},session={},config={singleTab:true,autoManage:true,autoLogin:true};
  let url='https://rez.metu.edu.tr/',documentId='top-1',pagePhase=phase,inspectCalls=0,readyCalls=0;
  const chrome={runtime:{id:'main_extension'},storage:{local:{get:async()=>({...state}),set:async value=>Object.assign(state,value)},session:{get:async()=>({...session}),set:async value=>Object.assign(session,value)}},
    tabs:{get:async()=>({id:9,url})},scripting:{executeScript:async()=>{inspectCalls++;return [{frameId:0,documentId,result:{phase:pagePhase}}];}}};
  const context={URL,Date,setTimeout,clearTimeout};runInNewContext(source,context);
  const api=context.RezVerification.create({chrome,readConfig:async()=>config,nativeReady,onReady:()=>{readyCalls++;},wait:async()=>{}});
  const sender={id:'main_extension',frameId:2,documentId:'frame-1',url:'https://challenges.cloudflare.com/example',tab:{id:9,url}};
  const message=(message,s=sender)=>new Promise(resolve=>{assert.equal(api.handleMessage(message,s,resolve),true);});
  return {state,session,config,api,sender,chrome,context,message,inspectCalls:()=>inspectCalls,readyCalls:()=>readyCalls,
    phase:v=>pagePhase=v,url:v=>url=v,document:v=>documentId=v};
}
test('only active managed auto-login tabs can authorise the verification control',async()=>{
  for(const change of [f=>f.state.paused=true,f=>delete f.state.paused,f=>f.state.authBlocked=true,
    f=>f.config.maintenance=true,f=>f.config.autoLogin=false,f=>f.config.autoManage=false,f=>f.state.singleTabId=10]){
    const f=fixture();change(f);assert.equal((await f.api.preflight(f.sender)).allowed,false);assert.equal(f.inspectCalls(),0);
  }
  const f=fixture();assert.equal((await f.api.preflight(f.sender)).allowed,true);
});
test('a current widget response, signed-in page, unknown page or denial never triggers a new click',async()=>{
  for(const phase of ['signed_in','widget_ready','denied','unknown']){
    const f=fixture({phase});assert.equal((await f.api.preflight(f.sender)).allowed,false);
  }
  const f=fixture({phase:'challenge'});assert.equal((await f.api.preflight(f.sender)).allowed,true);
});
test('other sites, senders, top frames and booking forms are rejected',async()=>{
  const f=fixture();for(const delta of [{id:'other'},{frameId:0},{documentId:undefined},
    {url:'https://challenges.cloudflare.com.evil.invalid/'},{tab:{id:9,url:'https://other.invalid/'}},
    {tab:{id:9,url:'https://rez.metu.edu.tr/view/reservationControl/reservation/createReservation.jsf'}}]){
    assert.equal((await f.api.preflight({...f.sender,...delta})).allowed,false);
  }
  assert.equal(f.inspectCalls(),0);
});
test('navigation away from the login between frame creation and preflight denies permission',async()=>{
  const f=fixture();f.url('https://rez.metu.edu.tr/view/reservationControl/reservation/createReservation.jsf');
  assert.equal((await f.api.preflight(f.sender)).allowed,false);assert.equal(f.inspectCalls(),0);
});
test('the top document shares one attempt across concurrent requests and replacement frames',async()=>{
  const f=fixture();const outcomes=await Promise.all([f.api.preflight(f.sender),f.api.preflight({...f.sender,documentId:'frame-2'})]);
  assert.equal(outcomes.filter(v=>v.allowed).length,1);
  assert.equal((await f.api.preflight({...f.sender,documentId:'frame-3'})).allowed,false);
  f.document('top-2');assert.equal((await f.api.preflight({...f.sender,documentId:'frame-4'})).allowed,true);
});
test('stopping during top-page inspection cancels the authorisation',async()=>{
  const f=fixture();const inspect=f.chrome.scripting.executeScript;
  f.chrome.scripting.executeScript=async()=>{const result=await inspect();f.state.paused=true;return result;};
  assert.equal((await f.api.preflight(f.sender)).allowed,false);assert.equal(f.state.verificationStatus,undefined);
});
test('the once-per-document budget survives a service-worker restart',async()=>{
  const f=fixture();assert.equal((await f.api.preflight(f.sender)).allowed,true);
  const restarted=f.context.RezVerification.create({chrome:f.chrome,readConfig:async()=>f.config,wait:async()=>{}});
  assert.equal((await restarted.preflight({...f.sender,documentId:'replacement-frame'})).allowed,false);
  f.document('top-2');assert.equal((await restarted.preflight({...f.sender,documentId:'new-frame'})).allowed,true);
});
test('unavailable attempt-budget storage cannot authorise an untracked click',async()=>{
  const f=fixture();f.chrome.storage.session.get=async()=>{throw Error('storage unavailable');};
  assert.equal((await f.message({type:'rez-verification:preflight'})).allowed,false);
});
test('an attempt report without an authorised matching frame is ignored',async()=>{
  const f=fixture();assert.equal((await f.message({type:'rez-verification:attempt',outcome:'clicked'})).ok,false);
  await f.api.preflight(f.sender);
  assert.equal((await f.message({type:'rez-verification:attempt',outcome:'clicked'},{...f.sender,documentId:'other-frame'})).ok,false);
  assert.equal((await f.message({type:'rez-verification:attempt',outcome:'forged_success'})).ok,false);
});
test('a failed click is recorded once and cannot trigger repeated reports or a retry storm',async()=>{
  const f=fixture();await f.api.preflight(f.sender);
  assert.equal((await f.message({type:'rez-verification:attempt',outcome:'click_failed'})).ok,true);
  assert.equal(f.state.verificationStatus.outcome,'click_failed');
  assert.equal((await f.message({type:'rez-verification:attempt',outcome:'clicked'})).ok,false);
  assert.equal((await f.api.preflight(f.sender)).allowed,false);assert.equal(f.readyCalls(),0);
});
test('uncompleted verification is never presented as signed-in success',async()=>{
  const f=fixture();await f.api.watch(9);assert.equal(f.state.verificationStatus.outcome,'not_confirmed');assert.equal(f.readyCalls(),0);
  assert.deepEqual(Object.keys(f.state.verificationStatus).sort(),['at','outcome']);
});
test('a widget response wakes normal recovery once, while authentication remains a separate result',async()=>{
  const f=fixture({phase:'widget_ready'});await f.api.watch(9);await Promise.resolve();
  assert.equal(f.state.verificationStatus.outcome,'widget_ready');assert.equal(f.readyCalls(),1);
  f.phase('signed_in');await f.api.watch(9);await Promise.resolve();
  assert.equal(f.state.verificationStatus.outcome,'signed_in');assert.equal(f.readyCalls(),2);
});
test('a pause, source denial or changed context stops observation',async()=>{
  const stopped=fixture();stopped.state.paused=true;await stopped.api.watch(9);assert.equal(stopped.state.verificationStatus.outcome,'cancelled');
  const denied=fixture({phase:'denied'});await denied.api.watch(9);assert.equal(denied.state.verificationStatus.outcome,'denied');
  const away=fixture();away.url('https://other.invalid/');await away.api.watch(9);assert.equal(away.state.verificationStatus.outcome,'context_changed');
});
test('ambiguous or failed top-document inspection fails closed',async()=>{
  const f=fixture();f.chrome.scripting.executeScript=async()=>[{frameId:1,result:{phase:'login'}}];
  assert.equal((await f.api.preflight(f.sender)).allowed,false);
  f.chrome.scripting.executeScript=async()=>{throw Error('unavailable');};
  assert.equal((await f.message({type:'rez-verification:preflight'})).allowed,false);
});
test('normal collection messages are left to the existing background listener',()=>{
  const f=fixture();assert.equal(f.api.handleMessage({type:'rez:set-paused'},f.sender,()=>{}),false);
});
test('portal inspection returns a phase without copying form values',()=>{
  const f=fixture();const secret='synthetic-fixture-value';
  const context={location:{origin:'https://rez.metu.edu.tr',pathname:'/'},document:{body:{textContent:''},title:'',getElementById:()=>null,
    querySelector:s=>s==='input[type=password]'||s.includes('cf-turnstile-response')?{value:secret}:null}};
  runInNewContext(`const inspect=${f.context.RezVerification.inspectPortal.toString()};globalThis.result=inspect();`,context);
  assert.equal(context.result.phase,'widget_ready');assert.ok(!JSON.stringify(context.result).includes(secret));
});

test('native input requires its authorised frame, current document and explicit opt-in',async()=>{
 const f=fixture();f.config.nativeVerification=true;const sent=[];let focused=0;
 f.chrome.tabs.get=async()=>({id:9,url:'https://rez.metu.edu.tr/',windowId:1});f.chrome.tabs.update=async()=>{};
 f.chrome.windows={update:async()=>{focused++;}};
 const inspect=f.chrome.scripting.executeScript;
 f.chrome.scripting.executeScript=async opts=>opts.func.name==='inspectNativeGeometry'?[{frameId:0,documentId:'top-1',result:{frame:{x:380,y:420,width:300,height:70},viewport:{x:10,y:140,width:1050,height:660}}}]:inspect(opts);
 const api=f.context.RezVerification.create({chrome:f.chrome,readConfig:async()=>f.config,nativeClick:async p=>{sent.push(p);return true;},wait:async()=>{}});
 const msg=(value,sender=f.sender)=>new Promise(resolve=>api.handleMessage(value,sender,resolve));
 assert.equal((await msg({type:'rez-verification:native',position:{x:20,y:30}})).ok,false);
 assert.equal((await api.preflight(f.sender)).native,true);
 assert.equal((await msg({type:'rez-verification:native',position:{x:20,y:30}},{...f.sender,documentId:'other'})).ok,false);
 assert.equal((await msg({type:'rez-verification:native',position:{x:20,y:30}})).ok,true);
 assert.equal(sent.length,1);assert.equal(sent[0].x,400);assert.equal(sent[0].y,450);assert.equal(focused,1);
 assert.equal((await msg({type:'rez-verification:native',position:{x:20,y:30}})).ok,false);
});

test('a temporary native lock waits without consuming the document attempt, then authorises the same frame once',async()=>{
 let ready=false;const f=fixture({nativeReady:async()=>({ready,retryable:!ready})});f.config.nativeVerification=true;
 const pending=await f.api.preflight(f.sender);assert.equal(pending.allowed,false);assert.equal(pending.retryable,true);assert.equal(f.session.verificationAttempts,undefined);
 ready=true;assert.equal((await f.api.preflight(f.sender)).allowed,true);
 assert.equal((await f.api.preflight(f.sender)).allowed,false,'successful authorisation still uses one document budget');
});
test('maintenance defers permission without spending a document and can resume in that same document',async()=>{
 const f=fixture();f.config.maintenance=true;const pending=await f.api.preflight(f.sender);assert.equal(pending.allowed,false);assert.equal(pending.retryable,true);
 assert.equal(f.session.verificationAttempts,undefined);f.config.maintenance=false;assert.equal((await f.api.preflight(f.sender)).allowed,true);
});
