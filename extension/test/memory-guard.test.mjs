import test from 'node:test';
import assert from 'node:assert/strict';
import '../memory-guard.js';
function fixture(){
 let at=Date.parse('2026-10-29T09:00:00Z');const calls=[],state={paused:false,singleTabId:7},tabs=[{id:7,url:'https://rez.metu.edu.tr/view/home.jsf'},{id:8,url:'https://example.test/personal'}];
 const chrome={storage:{local:{get:async()=>({...state}),set:async v=>{Object.assign(state,v);calls.push(['store',v]);}}},tabs:{query:async()=>tabs,create:async options=>{calls.push(['create',options]);const tab={id:9,pendingUrl:options.url};tabs.push(tab);return tab;},update:async id=>calls.push(['update',id]),remove:async id=>{calls.push(['remove',id]);tabs.splice(tabs.findIndex(t=>t.id===id),1);}}};
 let page='home',reportFails=false,inspections=0;
 const report=async(_config,record)=>{calls.push(['report',record.phase]);if(reportFails)throw new Error('local unavailable');};
 const create=()=>globalThis.RezMemoryGuard.create({chrome,now:()=>at,inspect:async()=>{inspections++;return {page};},report});
 const config={singleTab:true,autoManage:true,memoryRecycle:{token:'a'.repeat(32),requestedAt:new Date(at).toISOString()},reserveMemoryPreparation:async()=>true};
 return {state,tabs,calls,chrome,config,create,guard:create(),advance:ms=>at+=ms,page:v=>page=v,reportFails:v=>reportFails=v,inspections:()=>inspections};
}
test('replacement is remembered before closing only the old managed tab; request executes once',async()=>{
 const f=fixture();assert.equal(await f.guard.maybeRotate(f.config),true);
 assert.deepEqual(f.tabs.map(t=>t.id),[8,9]);assert.equal(f.state.singleTabId,9);
 const create=f.calls.findIndex(c=>c[0]==='create'),store=f.calls.findIndex(c=>c[0]==='store'&&c[1].singleTabId===9),remove=f.calls.findIndex(c=>c[0]==='remove');
 assert.ok(create<store&&store<remove);assert.equal(f.state.memoryRecycle.phase,'rotated');
 await f.create().maybeRotate(f.config);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.filter(c=>c[0]==='report').length,1);
});
test('manual stop, maintenance, a challenge, expired requests and budget waits never create a tab',async()=>{
 for(const scenario of ['paused','maintenance','challenge','expired','budget','disabled']){
  const f=fixture();if(scenario==='paused')f.state.paused=true;if(scenario==='maintenance')f.config.maintenance=true;if(scenario==='challenge')f.page('challenge');if(scenario==='expired')f.advance(300001);if(scenario==='budget')f.config.reserveMemoryPreparation=async()=>false;if(scenario==='disabled')f.config.autoManage=false;
  assert.equal(await f.guard.maybeRotate(f.config),false,scenario);assert.equal(f.calls.filter(c=>c[0]==='create').length,0,scenario);
 }
});
test('failed creation retains the old tab, consumes request, and does not loop',async()=>{
 const f=fixture();f.chrome.tabs.create=async()=>{f.calls.push(['create']);throw new Error('unavailable');};
 await f.guard.maybeRotate(f.config);await f.create().maybeRotate(f.config);
 assert.equal(f.state.memoryRecycle.phase,'failed');assert.equal(f.state.singleTabId,7);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.filter(c=>c[0]==='remove').length,0);
});
test('a worker restart adopts its tagged pending replacement rather than creating a duplicate',async()=>{
 const f=fixture();f.state.memoryRecycle={...f.config.memoryRecycle,oldId:7,phase:'starting',at:f.config.memoryRecycle.requestedAt};
 f.tabs.push({id:12,pendingUrl:'https://rez.metu.edu.tr/view/home.jsf?rez-reader=1&rez-memory='+f.config.memoryRecycle.token});
 await f.guard.maybeRotate(f.config);assert.equal(f.state.singleTabId,12);assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
});
test('a lost local acknowledgement is retried without repeating site work',async()=>{
 const f=fixture();f.reportFails(true);await f.guard.maybeRotate(f.config);f.reportFails(false);await f.create().maybeRotate(f.config);
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.state.memoryRecycle.reported,true);
});
test('a second request within cooldown and malformed requests do nothing',async()=>{
 const f=fixture();await f.guard.maybeRotate(f.config);f.config.memoryRecycle.token='b'.repeat(32);f.advance(60000);assert.equal(await f.guard.maybeRotate(f.config),false);
 f.config.memoryRecycle.token='invalid';assert.equal(await f.guard.maybeRotate(f.config),false);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});

test('a stop received while reserving a preparation never creates a replacement',async()=>{
 const f=fixture();f.config.reserveMemoryPreparation=async()=>{f.state.paused=true;return true;};
 assert.equal(await f.guard.maybeRotate(f.config),false);assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
});

test('a worker restarted after expiry cannot resume an unfinished old request',async()=>{
 const f=fixture();f.state.memoryRecycle={...f.config.memoryRecycle,oldId:7,phase:'starting',at:f.config.memoryRecycle.requestedAt};
 f.advance(300001);assert.equal(await f.create().maybeRotate(f.config),false);assert.equal(f.calls.filter(c=>c[0]==='create').length,0);
});
