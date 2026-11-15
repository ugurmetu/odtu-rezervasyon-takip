import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {flushOutbox} from '../src/telegram.mjs';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rez-save-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'state.json'),store=new LocalStore(file,{accessMode:'public'});
 store.state.fastAvailability=true;store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'}]);
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10);store.admitChat(501);
 store.state.subscriptions.push({chatId:'501',facilityId:'17',date,startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true,active:true});
 store.save();let n=0;
 const observe=free=>store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:`save-proof-${++n}`,observed_at:new Date().toISOString(),
  facility:{id:'17',label:'Fitness'},view:{type:'day',date},slots:free===null?[]:[{date,start:'16:00',end:'17:30',free}]});
 const saves={n:0};const save=store.save.bind(store);store.save=()=>{saves.n++;return save();};
 return {file,store,observe,saves,onDisk:()=>JSON.parse(readFileSync(file,'utf8'))};
}
test('without a throttle every reading is written at once (tests and tools keep the old behaviour)',t=>{
 const f=fixture(t);f.observe(null);f.observe(null);assert.equal(f.saves.n,2);
});
test('routine readings are coalesced, but a queued alert is on disk before anyone can send it',t=>{
 const f=fixture(t);f.store.saveThrottleMs=60_000;f.store.lastSavedAt=Date.now();
 f.observe(null);f.observe(null);f.observe(null);assert.equal(f.saves.n,0,'three routine readings, no full rewrite');
 f.observe(2);assert.equal(f.saves.n,1,'the alert is persisted immediately');
 assert.equal(f.onDisk().outbox.filter(item=>item.status==='queued').length,1);
});
test('a pending write is flushed on shutdown and replaced by any full save',t=>{
 const f=fixture(t);f.store.saveThrottleMs=60_000;f.store.lastSavedAt=Date.now();
 f.observe(null);assert.ok(f.store.saveTimer,'a write is scheduled');
 const before=f.onDisk().engine;f.store.flushSave();assert.equal(f.store.saveTimer,null);
 assert.notDeepEqual(f.onDisk().engine,before,'the reading reached the disk');
 f.store.flushSave();assert.equal(f.saves.n,1,'nothing pending, nothing written');
});
test('an idle look at the alert queue (four times a second) writes nothing',async t=>{
 const f=fixture(t);for(let i=0;i<8;i++)await flushOutbox(f.store,{sendMessage:async()=>({message_id:1})});
 assert.equal(f.saves.n,0);
 f.observe(2);const after=f.saves.n;await flushOutbox(f.store,{sendMessage:async()=>({message_id:1})},{perSecond:100000});
 assert.ok(f.saves.n>after,'a real send is still written');
});
