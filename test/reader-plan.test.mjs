import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {requestedFacilities} from '../src/reader-facilities.mjs';
import {syncPublicReaderDates} from '../src/reader-plan.mjs';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rez-dates-')),file=join(dir,'local-config.json'),config={ingestUrl:'http://127.0.0.1:8765/ingest',key:'test_only_secret_not_a_real_key',autoManage:true,autoLogin:true,fastWatch:true,watchFacilities:['17','21'],watchDates:['2026-10-28','2026-10-29','2026-10-30']};writeFileSync(file,JSON.stringify(config));return {dir,file,config,close:()=>rmSync(dir,{recursive:true,force:true})};}
test('public date refresh follows the active week without changing facilities, login or secrets, and writes only when needed',()=>{const f=fixture();try{const opts={accessMode:'public',files:[f.file],now:Date.parse('2026-10-28T10:00:00Z')};const r=syncPublicReaderDates(opts);assert.deepEqual(r.dates,['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);assert.equal(r.changed,1);const config=JSON.parse(readFileSync(f.file));assert.deepEqual({...config,watchDates:f.config.watchDates},f.config);assert.equal(statSync(f.file).mode&0o777,0o600);assert.equal(syncPublicReaderDates(opts).changed,0);}finally{f.close();}});
test('Sunday 19:30 Istanbul switches to next Mon-Sun and a restart weeks later recalculates instead of ending a fixed test',()=>{const f=fixture();try{const run=at=>syncPublicReaderDates({accessMode:'public',files:[f.file],now:Date.parse(at)}).dates;assert.deepEqual(run('2026-11-01T16:29:59Z'),['2026-11-01']);assert.deepEqual(run('2026-11-01T16:30:00Z'),['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08']);assert.deepEqual(run('2026-11-18T10:00:00Z'),['2026-11-18','2026-11-19','2026-11-20','2026-11-21','2026-11-22']);}finally{f.close();}});
test('private fixed-date tests, unmanaged readers, missing files and unknown configurations are not silently modified',()=>{const f=fixture();try{assert.equal(syncPublicReaderDates({accessMode:'invite',files:[f.file]}).changed,0);assert.deepEqual(JSON.parse(readFileSync(f.file)),f.config);writeFileSync(f.file,JSON.stringify({...f.config,autoManage:false}));assert.equal(syncPublicReaderDates({accessMode:'public',files:[f.file]}).changed,0);writeFileSync(f.file,JSON.stringify({...f.config,watchFacilities:['3']}));assert.throws(()=>syncPublicReaderDates({accessMode:'public',files:[f.file]}),/unexpected/);assert.equal(syncPublicReaderDates({accessMode:'public',files:[join(f.dir,'missing')]}).changed,0);symlinkSync(f.file,join(f.dir,'link'));assert.throws(()=>syncPublicReaderDates({accessMode:'public',files:[join(f.dir,'link')]}),/symlink/);}finally{f.close();}});

test('tennis demand is enabled only after a capable reader handshake, shares one scan for all users, and expires browsing requests',()=>{
 const catalog=[{id:'17',label:'Baraka Fitness'},{id:'21',label:'ODTÜ Spor Merkezi Fitness'},{id:'1',label:'1 Nolu Açık Tenis Kortu (Büyük Spor Salonu)'},{id:'3',label:'3 Nolu Tenis Kortu (Büyük Spor Salonu)'},{id:'45',label:'Padel Kort 2'}];
 const now=Date.parse('2026-10-28T10:00:00Z'),subscriptions=[{facilityId:'3',date:'2026-10-29'},{facilityId:'3',date:'2026-10-30'},{facilityId:'45',date:'2026-10-29'}];
 const opts={catalog,subscriptions,requests:{'1':now,'4':now-16*60000},now};
 assert.deepEqual(requestedFacilities({...opts,capabilities:{maxFacilities:2}}),['17','21']);
 assert.deepEqual(requestedFacilities({...opts,capabilities:{maxFacilities:16}}),['17','21','1','3']);
 assert.deepEqual(requestedFacilities({...opts,capabilities:{maxFacilities:16},subscriptions:[],now:now+16*60000}),['17','21']);
});
test('compatible runtime JSON gains requested tennis without changing secrets or needing a source reload',()=>{
 const f=fixture();try{const now=Date.parse('2026-10-28T10:00:00Z');const state={facilityCatalog:[{id:'17',label:'Baraka Fitness'},{id:'21',label:'Teknokent Fitness'},{id:'3',label:'3 Nolu Açık Tenis Kortu (Büyük Spor Salonu)'}],readerCapabilities:{maxFacilities:2},subscriptions:[{facilityId:'3',date:'2026-10-29'}]};
 const run=()=>syncPublicReaderDates({accessMode:'public',files:[f.file],now,store:{state}});
 run();assert.deepEqual(JSON.parse(readFileSync(f.file)).watchFacilities,['17','21']);state.readerCapabilities.maxFacilities=16;run();
 const result=JSON.parse(readFileSync(f.file));assert.deepEqual(result.watchFacilities,['17','21','3']);assert.equal(result.key,f.config.key);assert.equal(result.autoLogin,true);assert.equal(run().changed,0);
 }finally{f.close();}
});

test('a full-registry reader scans every enabled sport and newly opened directorate, not only subscribed tennis',()=>{
 const catalog=[{id:'17',label:'Baraka'},{id:'21',label:'Fitness'},{id:'3',label:'Tenis'},{id:'45',label:'Padel'},{id:'49',label:'Yeni Havuz',unitId:'2'},{id:'50',label:'Kapalı',enabled:false}];
 assert.deepEqual(requestedFacilities({catalog,capabilities:{maxFacilities:200,catalogDiscovery:true}}),['3','17','21','45','49']);
});

test('full-registry runtime settings connect new unit metadata and user priorities without changing credentials',()=>{const f=fixture();try{const state={facilityCatalog:[{id:'17',label:'Baraka'},{id:'21',label:'Fitness'},{id:'45',label:'Padel'},{id:'49',label:'Havuz',unitId:'2'}],readerCapabilities:{maxFacilities:200,catalogDiscovery:true},subscriptions:[{facilityId:'45',date:'2026-10-29'}],readerScanMode:'priority'};syncPublicReaderDates({accessMode:'public',files:[f.file],now:Date.parse('2026-10-28T10:00:00Z'),store:{state}});const c=JSON.parse(readFileSync(f.file));assert.deepEqual(c.watchFacilities,['17','21','45','49']);assert.deepEqual(c.priorityFacilities,['45']);assert.equal(c.watchFacilityUnits['49'],'2');assert.equal(c.catalogDiscovery,true);assert.equal(c.key,f.config.key);}finally{f.close();}});

test('a proven single-tab reader keeps a single-tab runtime plan; legacy handshakes cannot enable it prematurely',()=>{
 const f=fixture();try{
  const state={facilityCatalog:[{id:'17',label:'Baraka'},{id:'21',label:'Fitness'}],readerCapabilities:{maxFacilities:200,catalogDiscovery:true,singleTab:true,parallelRead:true},subscriptions:[]};
  const run=()=>syncPublicReaderDates({accessMode:'public',files:[f.file],now:Date.parse('2026-10-28T10:00:00Z'),store:{state}});
  run();const c=JSON.parse(readFileSync(f.file));assert.equal(c.singleTab,true);assert.equal(c.parallelRead,false);assert.equal(c.scanMode,'single-tab');assert.equal(run().changed,0);
 }finally{f.close();}
});

test('single-tab freshness expects followed facilities every 30s and the rest within the shared budget',async()=>{
 const {facilityCadenceMs,scheduleFreshMs}=await import('../src/reader-facilities.mjs');
 const ids=Array.from({length:32},(_,i)=>String(i+1));
 const store={state:{readerPlan:{facilityIds:ids,scanMode:'single-tab',priorityFacilities:['3']}}};
 assert.equal(facilityCadenceMs(store,'3'),30000);
 assert.equal(facilityCadenceMs(store,'4'),80000);
 assert.equal(scheduleFreshMs(store,'4'),240000);
});

test('Sunday 20:55-22:15 Istanbul covers both publication windows at the same request budget',async()=>{
 const {inPublicationSweep,priorityFacilities}=await import('../src/reader-facilities.mjs');
 const at=time=>Date.parse(`2026-11-01T${time}Z`);
 assert.equal(inPublicationSweep(at('17:54:59')),false);
 for(const time of ['17:55:00','18:00:00','18:14:59','18:15:00','18:55:00','19:00:00','19:14:59'])assert.equal(inPublicationSweep(at(time)),true,time);
 assert.equal(inPublicationSweep(at('19:15:00')),false);
 assert.equal(inPublicationSweep(Date.parse('2026-10-31T18:05:00Z')),false,'Saturday');
 assert.equal(inPublicationSweep(Date.parse('2026-11-02T19:00:00Z')),false,'Monday');
 const catalog=[{id:'17',label:'Baraka Fitness'}],subscriptions=[{facilityId:'17',active:true,date:'2026-11-02'}];
 assert.deepEqual(priorityFacilities({catalog,subscriptions,now:at('18:05:00')}),[]);
 assert.deepEqual(priorityFacilities({catalog,subscriptions,now:at('19:05:00')}),[]);
 assert.deepEqual(priorityFacilities({catalog,subscriptions,now:at('19:15:00')}),['17']);
});

test('publication focus reaches the running reader via runtime config and restores followed facilities after 22:15',()=>{
 const f=fixture();try{
  const state={facilityCatalog:[{id:'17',label:'Baraka'},{id:'21',label:'Fitness'}],readerCapabilities:{maxFacilities:200,catalogDiscovery:true,singleTab:true},subscriptions:[{facilityId:'17',date:'2026-11-02'}]};
  const run=time=>{syncPublicReaderDates({accessMode:'public',files:[f.file],now:Date.parse(`2026-11-01T${time}Z`),store:{state}});return JSON.parse(readFileSync(f.file));};
  assert.deepEqual(run('17:54:59').priorityFacilities,['17']);
  for(const time of ['17:55:00','18:05:00','18:55:00','19:14:59']){
   const c=run(time);assert.deepEqual(c.priorityFacilities,[]);assert.deepEqual(c.watchFacilities,['17','21']);assert.equal(c.watchDates.length,7);assert.equal(c.key,f.config.key);assert.equal(c.autoLogin,true);assert.equal(c.scanMode,'single-tab');
  }
  assert.deepEqual(run('19:15:00').priorityFacilities,['17']);
 }finally{f.close();}
});

test('large single-tab registries pass every followed facility on as equal, however many people follow each one',()=>{
 const f=fixture();try{
  const ids=Array.from({length:32},(_,i)=>String(i+1));const catalog=ids.map(id=>({id,label:'Fitness '+id,unit:'Spor Müdürlüğü'}));
  const subscriptions=ids.slice(0,7).map(facilityId=>({chatId:'1',facilityId,date:'2026-10-30'}));
  subscriptions.push({chatId:'2',facilityId:'6',date:'2026-10-30'},{chatId:'3',facilityId:'7',date:'2026-10-30'});
  for(let i=0;i<10;i++)subscriptions.push({chatId:'1',facilityId:'1',date:'2026-10-30'});
  const state={facilityCatalog:catalog,readerCapabilities:{maxFacilities:200,catalogDiscovery:true,singleTab:true},subscriptions};
  const run=time=>{syncPublicReaderDates({accessMode:'public',files:[f.file],now:Date.parse(time),store:{state}});return JSON.parse(readFileSync(f.file));};
  const c=run('2026-10-29T10:00:00Z');assert.deepEqual(c.watchFacilities,ids);assert.deepEqual(c.priorityFacilities,['1','2','3','4','5','6','7']);assert.equal(c.key,f.config.key);
  const sunday=run('2026-11-01T18:00:00Z');assert.deepEqual(sunday.priorityFacilities,[]);assert.deepEqual(sunday.watchFacilities,ids);
 }finally{f.close();}
});
