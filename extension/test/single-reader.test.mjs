import test from 'node:test';
import assert from 'node:assert/strict';
import '../single-reader.js';
import '../parallel-reader.js';
function fixture(){
 let at=1_000_000;const state={paused:false};
 const chrome={storage:{local:{get:async()=>({...state}),set:async v=>Object.assign(state,v)}}};
 const create=()=>globalThis.RezSingle.create({chrome,now:()=>at});
 return {state,chrome,create,reader:create(),at:()=>at,advance:ms=>at+=ms};
}
const config={autoManage:true,singleTab:true,watchFacilities:['1','2','17','21']};
test('one facility retains its turn while preparing; no other task can mutate the same view',async()=>{
 const f=fixture(),seen=[];let done;const pending=new Promise(r=>done=r);
 const run=f.reader.pump(config,async id=>{seen.push(id);await pending;});
 await new Promise(r=>setImmediate(r));
 await f.reader.pump(config,async()=>assert.fail('overlapping collector'));
 done();await run;assert.deepEqual(seen,['1']);
 f.advance(1000);await f.reader.pump(config,async id=>seen.push(id));assert.deepEqual(seen,['1','1']);
 const restarted=f.create();f.advance(1000);
 await restarted.pump(config,async id=>{seen.push(id);f.state.facilityAttemptAt={[id]:f.at()};});
 f.advance(1000);await restarted.pump(config,async id=>seen.push(id));
 assert.deepEqual(seen,['1','1','1','2']);
});
test('every facility in a 32-facility registry gets a turn without priority starvation or extra views',async()=>{
 const f=fixture(),ids=Array.from({length:32},(_,i)=>String(i+1)),seen=[];
 for(let i=0;i<64;i++){
  await f.reader.pump({...config,watchFacilities:ids},async id=>{seen.push(id);f.state.facilityAttemptAt={...f.state.facilityAttemptAt,[id]:f.at()};});f.advance(3000);
 }
 assert.deepEqual(seen,[...ids,...ids]);
});
test('manual stop and maintenance prevent collection, and a failed sticky preparation eventually yields to others',async()=>{
 const f=fixture();let calls=0;
 await f.reader.pump({...config,maintenance:true},async()=>calls++);
 f.state.paused=true;await f.reader.pump(config,async()=>calls++);assert.equal(calls,0);
 f.state.paused=false;await assert.rejects(f.reader.pump(config,async()=>{throw new Error('unavailable');}));
 f.advance(91000);await f.reader.pump(config,async id=>assert.equal(id,'2'));
});
test('single-tab preparation and calendar actions share a persistent global budget, including after worker restart',async()=>{
 const f=fixture(),c={...config,watchFacilities:['1','2']},pool=globalThis.RezParallel.create({chrome:f.chrome,now:f.at});
 assert.equal(await pool.reservePreparation(c,'1'),true);
 assert.equal(await pool.reserve(c,'1'),false);
 f.advance(1000);assert.equal(await pool.reserve(c,'1'),true);
 f.advance(1000);assert.equal(await pool.reserve(c,'1'),false);
 assert.equal(await pool.reservePreparation(c,'2'),true);
 const restarted=globalThis.RezParallel.create({chrome:f.chrome,now:f.at});
 assert.equal(await restarted.reservePreparation(c,'2'),false);
 f.advance(1000);assert.equal(await restarted.reserve(c,'2'),true);
 assert.deepEqual(f.state.singleActionLog.map(x=>x.kind),['prepare','calendar','prepare','calendar']);
 f.state.paused=true;f.advance(1000);assert.equal(await restarted.reservePreparation(c,'1'),false);
});
test('followed facilities come round every ~10-14s in turn; the rest get an evenly spaced share and stay within 90s',async()=>{
 const f=fixture(),ids=Array.from({length:32},(_,i)=>String(i+1)),pri=['5','9','30'],c={...config,watchFacilities:ids,priorityFacilities:pri};
 const reads=[];
 const collect=async id=>{reads.push([id,f.at()]);f.state.facilityAttemptAt={...f.state.facilityAttemptAt,[id]:f.at()};};
 for(let i=0;i<400;i++){await f.reader.pump(c,collect);f.advance(1000);}
 assert.ok(pri.every(id=>reads.slice(0,5).some(x=>x[0]===id)),'followed facilities are read at once');
 const gaps=id=>{const t=reads.filter(x=>x[0]===id).map(x=>x[1]);return t.slice(1).map((x,i)=>x-t[i]).filter((_,i)=>t[i]>1_000_000+120000);};
 for(const id of pri)for(const g of gaps(id))assert.ok(g>=10000&&g<=14000,`${id} ${g}`);
 for(const id of ids.filter(id=>!pri.includes(id))){assert.ok(reads.some(x=>x[0]===id),id);for(const g of gaps(id))assert.ok(g>=30000&&g<=90000,`${id} ${g}`);}
});
test('with many followed facilities they slow down evenly and the unfollowed ones still come round within 90s',async()=>{
 const f=fixture(),ids=Array.from({length:37},(_,i)=>String(i+1)),pri=ids.slice(0,25),c={...config,watchFacilities:ids,priorityFacilities:pri};
 const reads=[];
 const collect=async id=>{reads.push([id,f.at()]);f.state.facilityAttemptAt={...f.state.facilityAttemptAt,[id]:f.at()};};
 for(let i=0;i<600;i++){await f.reader.pump(c,collect);f.advance(1000);}
 const gaps=list=>list.flatMap(id=>{const t=reads.filter(x=>x[0]===id).map(x=>x[1]);return t.slice(1).map((x,i)=>x-t[i]).filter((_,i)=>t[i]>1_000_000+180000);});
 const followed=gaps(pri),others=gaps(ids.slice(25));
 assert.ok(Math.max(...followed)-Math.min(...followed)<=3000,'followed facilities share the reads evenly');
 assert.ok(Math.max(...followed)<=36000,`followed ${Math.max(...followed)}`);assert.ok(Math.max(...others)<=90000,`others ${Math.max(...others)}`);
});
test('a completed read starts the next one in the same pump instead of waiting for a clock tick',async()=>{
 const f=fixture(),c={...config,watchFacilities:['1','2','3']};
 const reader=globalThis.RezSingle.create({chrome:f.chrome,now:f.at,readConfig:async()=>c});const seen=[];
 await reader.pump(c,async id=>{seen.push(id);f.advance(1200);f.state.facilityAttemptAt={...f.state.facilityAttemptAt,[id]:f.at()};});
 assert.deepEqual(seen,['1','2','3']);
 const waiting=[];f.advance(1000);
 await reader.pump(c,async id=>{waiting.push(id);});
 assert.deepEqual(waiting,[],'every facility is inside its interval');
 f.advance(30000);const blocked=[];
 await reader.pump(c,async id=>{blocked.push(id);});
 assert.deepEqual(blocked,['1'],'an unfinished read (sign-in, budget wait) yields to the next tick');
});
test('direct reads record each real site action in the shared minute budget',async()=>{
 const f=fixture(),c={...config,watchFacilities:['1','2'],directRead:true},pool=globalThis.RezParallel.create({chrome:f.chrome,now:f.at});
 assert.equal(await pool.reserve(c,'1'),true);const start=f.at();
 await pool.recordActions('1',[start+20,start+1100]);
 assert.deepEqual(f.state.singleActionLog.map(x=>[x.kind,x.at-start]),[['calendar',20],['read',1100]]);
 f.advance(1500);assert.equal(await pool.reserve(c,'2'),false,'the second action was less than 1s ago');
 f.advance(600);assert.equal(await pool.reserve(c,'2'),true);
 f.advance(1000);f.state.facilityAttemptAt={};
 f.state.singleActionLog=Array.from({length:60},(_,i)=>({id:'2',at:f.at()-58000+i,kind:'read'}));
 assert.equal(await pool.reserve(c,'1'),false,'no room left for a five-action read inside 64 per minute');
});

test('a read refused only by the 1-second pace waits the rest of that second instead of the next clock tick',async()=>{
 const f=fixture(),c={...config,watchFacilities:['1','2'],directRead:true},waits=[];
 const pool=globalThis.RezParallel.create({chrome:f.chrome,now:f.at,sleep:async ms=>{waits.push(ms);f.advance(ms);}});
 assert.equal(await pool.reserve(c,'1'),true);
 f.advance(700);assert.equal(await pool.reserveWithin(c,'2'),true);assert.deepEqual(waits,[305]);
 const [a,b]=f.state.singleActionLog.slice(-2).map(x=>x.at);assert.ok(b-a>=1000,'site actions stay at least 1s apart');
 assert.equal(await pool.reserveWithin(c,'2'),false,'its own 30s interval is not waited out');assert.equal(waits.length,1);
 f.advance(1000);f.state.facilityAttemptAt={};f.state.singleActionLog=Array.from({length:60},(_,i)=>({id:'2',at:f.at()-30000+i,kind:'read'}));
 assert.equal(await pool.reserveWithin(c,'1'),false,'a full minute budget is left to the clock');assert.equal(waits.length,1);
});

test('memory rotation waits for capture completion and prevents the next capture in the same serialized pump',async()=>{
 const f=fixture(),c={...config,watchFacilities:['1','2']};let rotate=false,inspecting=false;const seen=[];
 const reader=globalThis.RezSingle.create({chrome:f.chrome,now:f.at,readConfig:async()=>c,beforeTurn:async()=>{assert.equal(inspecting,false);return !rotate;}});
 await reader.pump(c,async id=>{inspecting=true;seen.push(id);f.state.facilityAttemptAt={[id]:f.at()};rotate=true;inspecting=false;});
 assert.deepEqual(seen,['1']);
});
