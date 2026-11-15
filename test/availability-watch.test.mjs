import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {flushOutbox} from '../src/telegram.mjs';

test('dated availability watch confirms a newly published matching slot twice and lets the bot deliver it once', async () => {
  const folder=mkdtempSync(join(tmpdir(),'rez-available-'));
  const now=Date.now(), date=new Date(now+86400000).toISOString().slice(0,10);
  const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_invite_2026_abcdef'});
  store.approveBetaChat('123','test_invite_2026_abcdef');
  store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);
  store.subscribe('123','17',{date,startAfter:'15:30',notifyAvailable:true});
  const snap=(id,at,slots)=>({schema:1,source:'rez-calendar-extension',fresh:true,
    refresh_id:id,observed_at:new Date(at).toISOString(),state:'ok',facility:{id:'17',label:'Baraka'},
    view:{type:'day',date},slots:slots.map(([start,free])=>({date,start,end:start==='16:00'?'17:30':'15:30',free}))});
  try {
    store.ingest(snap('available-empty',now-240000,[]));
    store.ingest(snap('available-first',now-180000,[['16:00',2],['14:00',4]]));
    assert.equal(store.status().queued,0);
    store.ingest(snap('available-first',now-180000,[['16:00',2]]));
    assert.equal(store.status().queued,0);
    store.ingest(snap('available-second',now-60000,[['16:00',1]]));
    assert.equal(store.status().queued,1);
    const sent=[];
    assert.equal(await flushOutbox(store,{async sendMessage(_chat,text){sent.push(text);}}),1);
    assert.match(sent[0],/16:00/);
    assert.doesNotMatch(sent[0],/14:00/);
    store.ingest(snap('available-third',now-10000,[['16:00',3]]));
    assert.equal(store.status().queued,0);
    assert.equal(sent.length,1);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('an absent session or failed read cancels an unconfirmed candidate', () => {
  const folder=mkdtempSync(join(tmpdir(),'rez-available-gap-'));
  const now=Date.now(), date=new Date(now+86400000).toISOString().slice(0,10);
  const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_invite_2026_abcdef'});
  store.approveBetaChat('123','test_invite_2026_abcdef');
  store.setFacilityCatalog([{id:'21',label:'Teknokent',unit:'Spor Müdürlüğü'}]);
  store.subscribe('123','21',{date,startAfter:'15:30',notifyAvailable:true});
  const snap=(id,at,slots)=>({schema:1,source:'rez-calendar-extension',fresh:true,refresh_id:id,
    observed_at:new Date(at).toISOString(),state:'ok',facility:{id:'21',label:'Teknokent'},
    view:{type:'day',date},slots:slots.map(free=>({date,start:'17:00',end:'18:30',free}))});
  try {
    store.ingest(snap('missing-first',now-240000,[1]));
    store.ingest(snap('missing-empty',now-200000,[]));
    store.ingest(snap('missing-return',now-180000,[1]));
    assert.equal(store.status().queued,0);
    store.ingest({schema:1,source:'rez-calendar-extension',fresh:false,state:'login_required',
      observed_at:new Date(now-120000).toISOString()});
    store.ingest(snap('missing-auth-return',now-60000,[1]));
    assert.equal(store.status().queued,0);
    store.ingest(snap('missing-confirmed',now-10000,[1]));
    assert.equal(store.status().queued,1);
    assert.throws(()=>store.subscribe('123','21',{notifyAvailable:true}),/explicit date/);
  } finally {rmSync(folder,{recursive:true,force:true});}
});

test('fast watch delivers the first verified positive once, without waiting for another read',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-fast-'));const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_invite_2026_abcdef'});const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
 try{
  store.state.fastAvailability=true;store.approveBetaChat('123','test_invite_2026_abcdef');store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);store.subscribe('123','17',{date,startAfter:'15:30',notifyAvailable:true});
  const snapshot=(refresh,free=2)=>({schema:1,source:'rez-calendar-extension',fresh:true,refresh_id:refresh,observed_at:new Date().toISOString(),state:'ok',facility:{id:'17',label:'Baraka'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free}]});
  store.ingest(snapshot('first-fast-read'));assert.equal(store.status().queued,1);const delivered=[];await flushOutbox(store,{sendMessage:async(_chat,text,_markup,timeout)=>{delivered.push(text);assert.ok(timeout<=5000);}});assert.equal(delivered.length,1);
  store.ingest(snapshot('second-fast-read'));assert.equal(store.status().queued,0);assert.equal(store.state.outbox.length,1);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test('fast watch never alerts on zero, passive, empty or delayed observations and keeps a queued alert for three minutes so thousands of watchers can be reached, then expires it',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-fast-safe-'));const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_invite_2026_abcdef'});const now=Date.now(),date=new Date(now+86400000).toISOString().slice(0,10);
 try{
  store.state.fastAvailability=true;store.approveBetaChat('123','test_invite_2026_abcdef');store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);store.subscribe('123','17',{date,notifyAvailable:true});
  const snap=(id,free,age=0)=>({schema:1,source:'rez-calendar-extension',fresh:true,refresh_id:id,observed_at:new Date(Date.now()-age).toISOString(),state:'ok',facility:{id:'17',label:'Baraka'},view:{type:'day',date},slots:free===null?[]:[{date,start:'16:00',end:'17:30',free}]});
  store.ingest(snap('delayed-fast-read',2,11000));store.ingest(snap('zero-fast-read',0));store.ingest(snap('empty-fast-read',null));store.ingest({...snap('passive-fast-read',2),fresh:false,refresh_id:undefined});assert.equal(store.status().queued,0);
  store.ingest(snap('fresh-fast-read',2));assert.equal(store.status().queued,1);store.expireStaleDeliveries(Date.now()+61000);assert.equal(store.state.outbox[0].status,'queued');store.expireStaleDeliveries(Date.now()+181000);assert.equal(store.state.outbox[0].status,'expired');
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('Telegram retry-after also blocks newly discovered fast alerts instead of bypassing its window',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-fast-retry-'));const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_invite_2026_abcdef'});const now=Date.now(),date=new Date(now+86400000).toISOString().slice(0,10);
 try{
  store.state.fastAvailability=true;store.approveBetaChat('123','test_invite_2026_abcdef');store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);store.subscribe('123','17',{date,notifyAvailable:true});store.deferQueuedUntil(now+30000);
  store.ingest({schema:1,source:'rez-calendar-extension',fresh:true,refresh_id:'fast-rate-limit-read',observed_at:new Date().toISOString(),state:'ok',facility:{id:'17',label:'Baraka'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free:2}]});
  assert.equal(store.status().queued,1);assert.equal(store.dueDeliveries().length,0);assert.equal(store.beginDelivery(store.state.outbox[0].id),false);
  const restored=new LocalStore(store.file,{betaInviteCode:'test_invite_2026_abcdef'});assert.equal(restored.dueDeliveries().length,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('overlapping filters with different confirmation times share one chat/session delivery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-overlap-')),store=new LocalStore(join(dir,'state.json'),{accessMode:'public'}),date=new Date(Date.now()+86400000).toISOString().slice(0,10);
 try{
  store.admitChat(123);store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);
  store.subscribe(123,'17',{date,startAfter:'15:30',notifyAvailable:true});store.state.subscriptions.push({chatId:'123',facilityId:'17',active:true,date,startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true});
  for(const [i,s] of store.state.subscriptions.entries())s.availabilityChecks={'16:00|17:30':{candidate:{at:Date.now()-60000-i*1000,refreshId:'older-'+i}}};
  store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:'overlap-next',observed_at:new Date().toISOString(),facility:{id:'17',label:'Baraka'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free:1}]});
  assert.equal(store.status().queued,1);let messages=0;await flushOutbox(store,{sendMessage:async()=>({message_id:++messages})});assert.equal(messages,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an uncertain initial delivery is not recreated after its filter is replaced',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-uncertain-filter-')),store=new LocalStore(join(dir,'state.json'),{accessMode:'public'}),date=new Date(Date.now()+86400000).toISOString().slice(0,10);
 try{
  store.state.fastAvailability=true;store.admitChat(123);store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);store.subscribe(123,'17',{date,notifyAvailable:true});
  const observe=id=>store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:id,observed_at:new Date().toISOString(),facility:{id:'17',label:'Baraka'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free:1}]});
  observe('uncertain-start');await flushOutbox(store,{sendMessage:async()=>{throw new Error('timeout');}});assert.equal(store.status().uncertain,1);
  store.replaceDayFilters(123,'17',date,[{date,startAfter:'15:30',notifyAvailable:true}]);observe('uncertain-filter-replaced');assert.equal(store.status().queued,0);assert.equal(store.state.outbox.length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
