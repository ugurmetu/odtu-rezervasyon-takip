import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync,readFileSync,writeFileSync,statSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{acquireLock,releaseLock,setHold}from'../src/intervention.mjs';
import{createNativeVerification}from'../src/native-verification.mjs';
const payload=()=>({requestId:'document-123',expiresAt:Date.now()+5000,x:400,y:450,frame:{x:380,y:420,width:300,height:70},viewport:{x:10,y:140,width:1050,height:660}});
function fixture({enabled=true,title='ODTÜ SKSDB REZERVASYON SİSTEMİ - Login',pid='42',fail=false,privateDir=null,readControl=()=>true,now=()=>Date.now(),timeoutFail=false,pointerStart=[400,450],holdPointer=false}={}){
 const calls=[];let pointer=[...pointerStart];const run=async(program,args,options)=>{calls.push([program,args,options]);
 if(program==='systemctl')return '42\n';if(args[0]==='getwindowfocus')return '99\n';if(args[0]==='getwindowpid')return pid+'\n';
 if(args[0]==='getwindowname')return title;if(args[0]==='getwindowgeometry')return 'X=10\nY=10\nWIDTH=1050\nHEIGHT=790\n';
 if(args[0]==='getmouselocation')return `X=${pointer[0]}\nY=${pointer[1]}\nSCREEN=0\nWINDOW=99\n`;
 if(args[0]==='mousemove'){if(!holdPointer)pointer=[Number(args[1]),Number(args[2])];return '';}
 if(args[0]==='getdisplaygeometry')return '1280 900\n';if(timeoutFail){const error=Error('secret');error.killed=true;throw error;}if(fail)throw Error('driver failed');return '';};
 return{calls,api:createNativeVerification({enabled,run,privateDir,readControl,now})};
}
test('disabled by default unless explicitly enabled on Linux',async()=>{const f=fixture({enabled:false});assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'native_disabled');assert.equal(f.calls.length,0);});
test('only a scoped login rectangle in the focused owned browser emits one click',async()=>{const f=fixture();assert.deepEqual(await f.api.click(payload(),{phase:'waiting_verification'}),{ok:true});assert.deepEqual(f.calls.at(-1),['xdotool',['click','--clearmodifiers','1'],{timeout:8000}]);assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'already_used');});
test('ready, paused, access denied and rate limits never emit input',async()=>{for(const phase of ['ready','paused','site_access_denied','site_rate_limited','login_failed']){const f=fixture();assert.equal((await f.api.click(payload(),{phase})).reason,'wrong_phase');assert.equal(f.calls.length,0);}});
test('other windows and processes are rejected',async()=>{for(const opts of [{title:'Other site - Login'},{pid:'43'},{title:'ODTÜ SKSDB REZERVASYON SİSTEMİ - Hoş Geldiniz'}]){const f=fixture(opts);assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'wrong_window');assert.equal(f.calls.some(c=>c[1][0]==='mousemove'),false);}});
test('invalid or off-frame positions never reach the driver',async()=>{for(const change of [p=>p.x=0,p=>p.x=NaN,p=>p.frame.x=-1,p=>p.frame.width=1000,p=>p.requestId='bad',p=>p.viewport.height=10]){const f=fixture(),p=payload();change(p);assert.equal((await f.api.click(p,{phase:'waiting_verification'})).reason,'invalid_geometry');assert.equal(f.calls.length,0);}});
test('an uncertain input result consumes the one-document budget',async()=>{const f=fixture({fail:true});assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'native_unavailable');assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'already_used');});
test('expired requests and a different-document burst do not emit input',async()=>{const f=fixture(),p=payload();p.expiresAt=Date.now()-1;assert.equal((await f.api.click(p,{phase:'waiting_verification'})).reason,'expired_request');assert.equal(f.calls.length,0);assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).ok,true);const second=payload();second.requestId='document-456';assert.equal((await f.api.click(second,{phase:'waiting_verification'})).reason,'native_cooldown');assert.equal(f.calls.filter(c=>c[1][0]==='click').length,1);});

test('native input requires configuration opt-in and rechecks stop before input',async()=>{
 const off=fixture({readControl:()=>false});assert.equal((await off.api.click(payload(),{phase:'waiting_verification'})).reason,'native_disabled');assert.equal(off.calls.length,0);
 let checks=0;const stopped=fixture({readControl:()=>++checks===1});assert.equal((await stopped.api.click(payload(),{phase:'waiting_verification'})).reason,'context_changed');assert.equal(stopped.calls.some(c=>c[1][0]==='mousemove'),false);
});
test('one-document budget and cooldown survive server restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-budget-'));try{
  const first=fixture({privateDir:dir});assert.equal((await first.api.click(payload(),{phase:'waiting_verification'})).ok,true);
  assert.equal(statSync(join(dir,'native-verification.json')).mode&0o777,0o600);
  const restarted=fixture({privateDir:dir});assert.equal((await restarted.api.click(payload(),{phase:'waiting_verification'})).reason,'already_used');
  const p=payload();p.requestId='another-document';assert.equal((await restarted.api.click(p,{phase:'waiting_verification'})).reason,'native_cooldown');
  assert.equal(restarted.calls.length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('shared maintenance lock and hold prevent input without consuming a document',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-lock-'));try{
  const f=fixture({privateDir:dir});acquireLock(dir,'codex-deploy',60000);
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'intervention_busy');assert.equal(f.calls.length,0);
  releaseLock(dir,'codex-deploy');setHold(dir,'operator',60000);
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'intervention_hold');assert.equal(f.calls.length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a damaged persistent input budget stays fail-closed and is not replaced',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-damaged-'));try{
  const file=join(dir,'native-verification.json');writeFileSync(file,'broken');const f=fixture({privateDir:dir});
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'native_unavailable');assert.equal(f.calls.length,0);assert.equal(readFileSync(file,'utf8'),'broken');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('input timeout is classified without logging error text and retains the one-click limit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-timeout-'));try{
  const f=fixture({privateDir:dir,timeoutFail:true});
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'native_unavailable');
  const data=JSON.parse(readFileSync(join(dir,'native-verification.json'),'utf8'));
  assert.deepEqual(data.lastResult.detail.stage,'input');
  assert.equal(data.lastResult.detail.kind,'timeout');
  assert.equal(JSON.stringify(data.lastResult).includes('secret'),false);
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'already_used');
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('a pointer already at the target clicks once without waiting for motion',async()=>{
 const f=fixture();assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).ok,true);
 assert.equal(f.calls.some(c=>c[1].includes('--sync')),false);
 assert.equal(f.calls.some(c=>c[1][0]==='mousemove'),false);
 assert.equal(f.calls.filter(c=>c[1][0]==='click').length,1);
});

test('a different pointer position is moved and verified before the single click',async()=>{
 const f=fixture({pointerStart:[100,100]});assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).ok,true);
 assert.deepEqual(f.calls.find(c=>c[1][0]==='mousemove')[1],['mousemove','400','450']);
 assert.equal(f.calls.filter(c=>c[1][0]==='getmouselocation').length,2);
 assert.equal(f.calls.filter(c=>c[1][0]==='click').length,1);
});

test('a pointer that failed to move cannot click or replay the same document',async()=>{
 const f=fixture({pointerStart:[100,100],holdPointer:true});
 assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'pointer_position_changed');
 assert.equal(f.calls.some(c=>c[1][0]==='click'),false);
 assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'already_used');
});

test('stop after pointer verification prevents a click',async()=>{
 let checks=0;const f=fixture({readControl:()=>++checks<3});
 assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).reason,'context_changed');
 assert.equal(f.calls.some(c=>c[1][0]==='click'),false);
});

test('passive native readiness waits for the shared lock without reserving or sending any input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-ready-'));try{
  const f=fixture({privateDir:dir});acquireLock(dir,'watchdog',60000);
  assert.deepEqual(await f.api.readiness({phase:'waiting_verification'}),{ready:false,retryable:true});assert.equal(f.calls.length,0);
  releaseLock(dir,'watchdog');assert.deepEqual(await f.api.readiness({phase:'waiting_verification'}),{ready:true,retryable:false});assert.equal(f.calls.length,0);
  assert.equal((await f.api.click(payload(),{phase:'waiting_verification'})).ok,true,'readiness did not spend the document');
  assert.deepEqual(await f.api.readiness({phase:'waiting_verification'}),{ready:false,retryable:true},'input cooldown remains in force');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('corrupt native budget and disabled configuration cannot report readiness',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-native-ready-bad-'));try{
  writeFileSync(join(dir,'native-verification.json'),'broken');const f=fixture({privateDir:dir});assert.deepEqual(await f.api.readiness({phase:'waiting_verification'}),{ready:false,retryable:false});assert.equal(f.calls.length,0);assert.equal(readFileSync(join(dir,'native-verification.json'),'utf8'),'broken');
  assert.equal((await fixture({readControl:()=>false}).api.readiness({phase:'waiting_verification'})).ready,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
