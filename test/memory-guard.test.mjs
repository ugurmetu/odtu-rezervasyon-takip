import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryGuard,normalizeMemoryRecycle} from '../src/memory-guard.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rez-memory-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let at=Date.parse('2026-10-29T09:00:00Z'),usage={current:500*2**20,resident:350*2**20},serial=1;
 const file=join(dir,'config.json'),stateFile=join(dir,'memory.json');
 writeFileSync(file,JSON.stringify({autoManage:true,singleTab:true,key:'synthetic-only',watchDates:['2026-10-29']}));
 const store={state:{readerCapabilities:{memoryGuard:true},readerState:{phase:'ready',at:new Date(at).toISOString()}},engine:{health:{lastState:'ready'},pages:{}}};
 const create=()=>createMemoryGuard({store,configFiles:[file],stateFile,historyFile:join(dir,'history.ndjson'),now:()=>at,readUsage:()=>usage,token:()=>String(serial++).padStart(32,'0')});
 const f={store,file,stateFile,create,guard:create(),at:()=>at,config:()=>JSON.parse(readFileSync(file)),advance(ms=60000){at+=ms;store.state.readerState.at=new Date(at).toISOString();},usage(v){usage=v;},high(){usage={current:1300*2**20,resident:1000*2**20};},low(){usage={current:500*2**20,resident:350*2**20};}};return f;
}
test('only sustained real memory pressure requests a recycle; runtime dates and secrets survive',t=>{
 const f=fixture(t);assert.equal(f.guard.tick().status,'observing');
 f.high();f.advance();assert.equal(f.guard.tick().highSamples,1);assert.equal(f.config().memoryRecycle,undefined);
 f.advance();const s=f.guard.tick();assert.equal(s.status,'requested');assert.equal(s.requests.length,1);
 assert.equal(f.config().key,'synthetic-only');assert.deepEqual(f.config().watchDates,['2026-10-29']);
 assert.equal(lstatSync(f.file).mode&0o777,0o600);
 f.advance();f.guard.tick();assert.equal(f.config().memoryRecycle.token,s.pending.token,'pending request is not replaced');
});
test('cold file cache, a single spike, and safe low memory never recycle',t=>{
 const f=fixture(t);f.usage({current:1500*2**20,resident:500*2**20});f.guard.tick();f.advance();assert.equal(f.guard.tick().requests.length,0);
 f.high();f.advance();f.guard.tick();f.low();f.advance();assert.equal(f.guard.tick().highSamples,0);
 assert.equal(f.config().memoryRecycle,undefined);
});
test('paused, verification, stale reader and unsupported runtime do not trigger site work',t=>{
 for(const phase of ['paused','waiting_verification','site_rate_limited','site_access_denied','login_failed']){
  const f=fixture(t);f.high();f.store.state.readerState.phase=phase;f.guard.tick();f.advance();assert.equal(f.guard.tick().requests.length,0,phase);
 }
 const f=fixture(t);f.high();f.store.state.readerCapabilities.memoryGuard=false;f.guard.tick();f.advance();assert.equal(f.guard.tick().requests.length,0);
});
test('recovery requires both a new successful calendar read and reduced memory; survives a server restart',t=>{
 const f=fixture(t);f.high();f.guard.tick();f.advance();const requested=f.guard.tick();
 f.store.state.readerMemoryRecycle={token:requested.pending.token,phase:'rotated',at:new Date(f.at()).toISOString()};
 f.advance();f.low();assert.equal(f.create().tick().status,'requested','phase ready alone is insufficient');
 f.store.engine.pages.one={lastSuccessAt:new Date(f.at()).toISOString()};
 assert.equal(f.create().tick().status,'recovered');
 f.high();f.advance();f.guard.tick();f.advance();assert.equal(f.guard.tick().requests.length,1,'15 minute cooldown persists');
});
test('failed or unacknowledged replacement times out and is bounded to three requests per six hours',t=>{
 const f=fixture(t);f.high();f.guard.tick();f.advance();f.guard.tick();
 f.advance(301000);assert.equal(f.create().tick().status,'timeout');
 for(let n=0;n<3;n++){f.advance(901000);f.guard.tick();f.advance(301000);f.guard.tick();}
 assert.equal(f.create().tick().requests.length,3);assert.equal(f.create().tick().status,'reset_limit_reached');
});
test('maintenance disables pressure requests; acknowledgement accepts only bounded fields',t=>{
 const f=fixture(t);writeFileSync(f.file,JSON.stringify({singleTab:true,autoManage:true,maintenance:true}));f.high();f.guard.tick();f.advance();assert.equal(f.guard.tick().requests.length,0);
 const clean=normalizeMemoryRecycle({token:'a'.repeat(32),phase:'rotated',at:'2026-10-29T09:00:00Z',username:'discard-this'});
 assert.deepEqual(Object.keys(clean),['token','phase','at']);
 for(const v of [{}, {...clean,token:'x'}, {...clean,phase:'ready'}, {...clean,at:'invalid'}])assert.throws(()=>normalizeMemoryRecycle(v));
});
