import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {LocalStore}from'../src/store.mjs';import{flushOutbox,TelegramApi}from'../src/telegram.mjs';import{flushSlotUpdates,ageSlotAlerts,formatSlotStatus,rememberSlotAlert}from'../src/slot-alerts.mjs';
const invite='test_slot_lifecycle_2026';
// An in-memory transport: no Telegram or other network request is made.
function delayedAcknowledgement(options, result, milliseconds=5250){
 return new Promise((resolve,reject)=>{
  const signal=options.signal;
  if(signal.aborted){reject(signal.reason);return;}
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve(result);},milliseconds);
  signal.addEventListener('abort',abort,{once:true});
 });
}
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rez-slot-status-'));const store=new LocalStore(join(dir,'state.json'),{betaInviteCode:invite});
 store.state.fastAvailability=true;store.approveBetaChat(123,invite);store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'},{id:'21',label:'ODTÜ Spor Merkezi - Fitness Salonu',unit:'Spor Müdürlüğü'}]);
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10);store.subscribe(123,'17',{date,startAfter:'16:00',endBefore:'17:30',notifyAvailable:true,exactTime:true});let seq=0,at=Date.now()-500;
 const observe=(free,{id='17',fresh=true,dateOverride=date,refreshId}={})=>{seq++;at+=10;const raw={schema:1,source:'rez-calendar-extension',state:'ok',fresh,refresh_id:fresh?(refreshId||`lifecycle-proof-${seq}`):undefined,observed_at:new Date(at).toISOString(),facility:{id,label:'Fitness'},view:{type:'day',date:dateOverride},slots:free===null?[]:[{date:dateOverride,start:'16:00',end:'17:30',free}]};store.ingest(raw);return raw;};
 let sentCount=0;const sent=[],edited=[];const api={sendMessage:async(chat,text,markup,_timeout,replyTo)=>{sent.push({chat,text,replyTo,markup});return {message_id:100+(++sentCount)};},editMessageText:async(chat,message,text)=>{edited.push({chat,message,text});}};
 observe(2);await flushOutbox(store,api);sent.length=0;
 return {dir,store,date,observe,sent,edited,api,alert:()=>Object.values(store.state.slotAlerts)[0],close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('a smaller but positive count changes nothing: no edit and no new message',async()=>{const f=await fixture();try{f.observe(1);await flushSlotUpdates(f.store,f.api);assert.equal(f.edited.length,0);assert.equal(f.sent.length,0);}finally{f.close();}});
test('a delayed acknowledgement confirms Full, reopened and missing-reply fallback once instead of creating uncertainty',{timeout:12000},async()=>{
 await Promise.all(['full','reopened','reply_missing'].map(async kind=>{
  const f=await fixture();let calls=0,confirmed=0;
  try{
   if(kind==='reopened'){f.observe(0);await flushSlotUpdates(f.store,f.api);f.observe(3);}else f.observe(0);
   const api=new TelegramApi(`123:${'x'.repeat(24)}`,async(_url,options)=>{
    calls++;
    if(kind==='reply_missing'&&calls===1)return new Response(JSON.stringify({ok:false,description:'message to be replied not found'}),{status:400});
    await delayedAcknowledgement(options,null);
    confirmed++;return new Response(JSON.stringify({ok:true,result:{message_id:202}}));
   },null);
   await flushSlotUpdates(f.store,api);await flushSlotUpdates(f.store,api);
   assert.equal(confirmed,1,`${kind}: the late response must still confirm this send`);
   assert.equal(calls,kind==='reply_missing'?2:1,`${kind}: no ambiguous send is replayed`);
   assert.equal(f.store.state.slotUpdateUncertainAt,undefined);
   assert.equal(Object.keys(f.store.state.slotStatusJobs).length,0);
   assert.equal(f.alert().lastNotified,kind==='reopened'?'available':'full');
   if(kind==='reopened')assert.equal(f.alert().messageId,202);
  }finally{f.close();}
 }));
});
test('when the session fills, a separate short "Doldu" message replies to the alert; the alert itself is never rewritten',async()=>{const f=await fixture();try{f.observe(0);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/^🔴 Doldu\nBaraka Fitness · .+ 16:00–17:30$/);assert.equal(f.sent[0].replyTo,101);assert.equal(f.sent[0].markup,undefined);assert.equal(f.edited.length,0);f.observe(0);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);}finally{f.close();}});
test('one missing response is quiet; two misses in a row send one short "Doldu" message',async()=>{const f=await fixture();try{const first=f.observe(null);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);f.store.ingest(first);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);f.observe(null);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/^🔴 Doldu\n/);assert.doesNotMatch(f.sent[0].text,/site|olasılıkla|haber veririm/i);assert.ok(f.sent[0].text.split('\n').length<=2);assert.equal(f.edited.length,0);}finally{f.close();}});
test('a temporary omission followed by a positive response sends nothing',async()=>{const f=await fixture();try{f.observe(null);await flushSlotUpdates(f.store,f.api);f.observe(2);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);}finally{f.close();}});
test('filled then open again: one "Doldu" and one new "Yer açıldı" message, each sent once',async()=>{const f=await fixture();try{f.observe(0);await flushSlotUpdates(f.store,f.api);f.observe(3);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,2);assert.match(f.sent[1].text,/^🟢 Yer açıldı · Boş yer: 3\nBaraka Fitness · .+$/);assert.ok(f.sent[1].markup?.inline_keyboard?.flat().some(b=>b.url));f.observe(3);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,2);assert.equal(f.store.state.outbox.length,1);assert.equal(f.edited.length,0);}finally{f.close();}});
test('passive or unrelated observations never close a previously alerted session',async()=>{const f=await fixture();try{f.observe(0,{fresh:false});f.observe(0,{id:'21'});f.observe(0,{dateOverride:new Date(Date.now()+2*86400000).toISOString().slice(0,10)});await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);}finally{f.close();}});
test('a stale source sends nothing and leaves the alert as it was',async()=>{const f=await fixture();try{assert.equal(ageSlotAlerts(f.store,Date.now()+61000),true);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);}finally{f.close();}});
test('a passed booking deadline sends no extra message',async()=>{const f=await fixture();try{f.store.isSlotClosed=()=>true;await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);}finally{f.close();}});
test('unsubscribing drops pending follow-ups before they can be transmitted',async()=>{const f=await fixture();try{f.observe(0);f.store.unsubscribe(123,'17');await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);}finally{f.close();}});
test('a slow "Doldu" send is followed by the newer "Yer açıldı" once it reopens',async()=>{const f=await fixture();let release;try{f.observe(0);const gate=new Promise(r=>release=r);const work=flushSlotUpdates(f.store,{...f.api,sendMessage:async(...a)=>{await gate;return f.api.sendMessage(...a);}});await Promise.resolve();f.observe(2);release();await work;await flushSlotUpdates(f.store,f.api);assert.match(f.sent.at(-1).text,/^🟢 Yer açıldı/);assert.equal(f.sent.filter(x=>/Yer açıldı/.test(x.text)).length,1);}finally{release?.();f.close();}});
test('ambiguous sends are not automatically retried and an interrupted send remains uncertain after restart',async()=>{const f=await fixture();try{f.observe(0);let calls=0;await flushSlotUpdates(f.store,{...f.api,sendMessage:async()=>{calls++;throw new Error('lost response');}});await flushSlotUpdates(f.store,f.api);assert.equal(calls,1);assert.equal(f.sent.length,0);f.observe(3);const job=Object.values(f.store.state.slotStatusJobs)[0];job.notifyState='sending';f.store.save();const loaded=new LocalStore(f.store.file,{betaInviteCode:invite});await flushSlotUpdates(loaded,f.api);assert.equal(f.sent.length,0);}finally{f.close();}});
test('retry-after is shared by status updates and new availability deliveries',async()=>{const f=await fixture();try{f.observe(0);let calls=0;await flushSlotUpdates(f.store,{...f.api,sendMessage:async()=>{calls++;throw Object.assign(new Error('limited'),{status:429,retryAfterMs:30000});}});await flushSlotUpdates(f.store,f.api);assert.equal(calls,1);assert.equal(f.sent.length,0);assert.ok(f.store.state.deliveryBlockedUntil>Date.now());}finally{f.close();}});
test('an alert adopted from an older version stays quiet: no "Doldu" without a known "Yer açıldı"',async()=>{const f=await fixture();try{f.store.state.slotAlerts={};f.observe(0);await flushSlotUpdates(f.store,f.api);assert.equal(f.edited.length,0);assert.equal(f.sent.length,0);}finally{f.close();}});
test('never two "Doldu" in a row: a brief return before the reopen is sent changes nothing',async()=>{const f=await fixture();try{f.observe(0);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);f.observe(2);f.observe(0);await flushSlotUpdates(f.store,f.api);f.observe(null);f.observe(null);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);assert.equal(f.sent.filter(x=>/Doldu/.test(x.text)).length,1);}finally{f.close();}});
test('two misses 75 seconds apart (a facility read once a round) still send "Doldu"; misses minutes apart start over',async()=>{const f=await fixture();try{f.observe(null);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);f.alert().missingAt-=75_000;f.observe(null);await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/^🔴 Doldu\n/);}finally{f.close();}
 const g=await fixture();try{g.observe(null);g.alert().missingAt-=200_000;g.observe(null);await flushSlotUpdates(g.store,g.api);assert.equal(g.sent.length,0);assert.equal(g.alert().missingCount,1);}finally{g.close();}});
test('a "Doldu" job queued by an older rule for an alert without a sent "Yer açıldı" is dropped',async()=>{const f=await fixture();try{const alert=f.alert();delete alert.lastNotified;alert.status='unlisted';f.store.state.slotStatusJobs={[alert.key]:{key:alert.key,revision:alert.revision,status:'unlisted',free:null,observedAt:new Date().toISOString(),notify:true,notifyState:'pending',nextAt:0,attempts:0}};await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,0);assert.deepEqual(f.store.state.slotStatusJobs,{});}finally{f.close();}});
test('a 429 on "Doldu" keeps it pending and it is sent once later',async()=>{const f=await fixture();try{f.observe(0);await flushSlotUpdates(f.store,{...f.api,sendMessage:async()=>{throw Object.assign(new Error('limited'),{status:429,retryAfterMs:1});}});assert.equal(f.alert().lastNotified,'available');f.store.state.deliveryBlockedUntil=0;Object.values(f.store.state.slotStatusJobs)[0].nextAt=0;await flushSlotUpdates(f.store,f.api);assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/^🔴 Doldu/);assert.equal(f.alert().lastNotified,'full');}finally{f.close();}});

test('a rejected reply to a missing alert is sent once without a reply link',async()=>{
 const f=await fixture(),requests=[];
 try{
  const api=new TelegramApi('123456:'+'A'.repeat(24),async(_url,options)=>{
   const body=JSON.parse(options.body);requests.push(body);
   if(body.reply_parameters)return {ok:false,status:400,json:async()=>({ok:false,description:'Bad Request: message to be replied not found'})};
   return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:102}})};
  },null);
  f.observe(0);await flushSlotUpdates(f.store,api);f.observe(0);await flushSlotUpdates(f.store,api);
  assert.equal(requests.length,2);
  assert.equal(requests[0].reply_parameters.message_id,101);
  assert.equal(requests[1].reply_parameters,undefined);
  assert.equal(requests[1].text,requests[0].text);
  assert.equal(f.alert().lastNotified,'full');
  assert.equal(f.store.state.slotUpdateFailedAt,undefined);
 }finally{f.close();}
});

test('a confirmed rejection does not retry the same state or create a false reopening',async()=>{
 const f=await fixture();let attempts=0;
 try{
  f.alert().lastRenderedAt-=61_000;
  const api={sendMessage:async()=>{attempts++;throw Object.assign(new Error('arbitrary private response'),{status:400});}};
  f.observe(0);await flushSlotUpdates(f.store,api);
  assert.equal(f.store.state.slotUpdateFailureCode,'http_400');
  assert.equal(f.alert().lastNotified,'available');
  f.observe(0);await flushSlotUpdates(f.store,api);
  assert.equal(attempts,1);
  f.observe(3);await flushSlotUpdates(f.store,f.api);
  assert.equal(f.sent.length,0);
  f.observe(0);await flushSlotUpdates(f.store,f.api);
  assert.match(f.sent[0].text,/^🔴 Doldu/);
 }finally{f.close();}
});

test('a missing reply is not retried once the session reopens in flight',async()=>{
 const f=await fixture();let attempts=0;
 try{
  f.observe(0);
  await flushSlotUpdates(f.store,{sendMessage:async()=>{
   attempts++;f.observe(3);
   throw Object.assign(new Error('reply missing'),{status:400,replyTargetMissing:true});
  }});
  await flushSlotUpdates(f.store,f.api);
  assert.equal(attempts,1);
  assert.equal(f.alert().lastNotified,'available');
  assert.equal(f.sent.length,0);
 }finally{f.close();}
});

test('a blocked status send does not block new fast availability deliveries',async()=>{
 const f=await fixture();let release;try{
  f.observe(0);const gate=new Promise(r=>release=r);const status=flushSlotUpdates(f.store,{...f.api,sendMessage:async()=>{await gate;return {message_id:999};}});await Promise.resolve();
  f.store.subscribe(123,'21',{date:f.date,notifyAvailable:true});f.observe(2,{id:'21'});await flushOutbox(f.store,f.api);
  assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/Yer açıldı/);assert.equal(f.store.state.outbox.filter(d=>d.status==='sent').length,2);
  release();await status;
 }finally{release?.();f.close();}
});
test('tracking metadata is cleared after the dated retention window',async()=>{
 const f=await fixture();try{f.store.state.slotAlerts.old={key:'old',date:'2020-01-01',chatId:'123',messageId:42};f.store.state.slotStatusJobs={old:{key:'old'}};f.store.save();assert.equal(f.store.state.slotAlerts.old,undefined);assert.equal(f.store.state.slotStatusJobs.old,undefined);}finally{f.close();}
});
test('Telegram replies link to the original card and allow delivery if that card was deleted',async()=>{
 const {TelegramApi}=await import('../src/telegram.mjs');let body;
 const api=new TelegramApi('12345678:'+ 'A'.repeat(32),async(_url,options)=>{body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:7}})};});
 await api.sendMessage('123','status',undefined,5000,101);assert.deepEqual(body.reply_parameters,{message_id:101,allow_sending_without_reply:true});
});

test('each "Doldu" answers the latest "Yer açıldı"; a reopened place is a new message, not a reply',async()=>{const f=await fixture();try{
 f.observe(0);await flushSlotUpdates(f.store,f.api);
 f.observe(3);await flushSlotUpdates(f.store,f.api);
 f.observe(0);await flushSlotUpdates(f.store,f.api);
 assert.deepEqual(f.sent.map(x=>x.text.split('\n')[0]),['🔴 Doldu','🟢 Yer açıldı · Boş yer: 3','🔴 Doldu']);
 assert.equal(f.sent[0].replyTo,101,'first "Doldu" answers the original alert');
 assert.equal(f.sent[1].replyTo,null,'the reopened place is not a reply');
 assert.equal(f.sent[2].replyTo,103,'the next "Doldu" answers the reopened message (id 103)');
}finally{f.close();}});

test('pending follow-ups recheck cancellation before transport starts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-late-cancel-')),store=new LocalStore(join(dir,'state.json'),{accessMode:'public'});let release;const blocked=new Promise(r=>release=r);let calls=0;
 try{
  store.setFacilityCatalog([{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]);const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
  store.state.betaApprovedChatIds=Array.from({length:25},(_,i)=>String(1000+i));store.state.subscriptions=store.state.betaApprovedChatIds.map(chatId=>({chatId,facilityId:'17',active:true,date,startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true}));
  for(const chatId of store.state.betaApprovedChatIds)rememberSlotAlert(store,{chatId,event:{facility:{id:'17'},date,start:'16:00',end:'17:30',free:1,observedAt:new Date().toISOString()}},Number(chatId));
  store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:'cancel-proof-full',observed_at:new Date().toISOString(),facility:{id:'17',label:'Fitness'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free:0}]});
  const running=flushSlotUpdates(store,{sendMessage:async()=>{calls++;await blocked;return {message_id:1};}},{max:25});await new Promise(r=>setImmediate(r));assert.equal(calls,8);
  store.state.subscriptions=[];store.save();release();await running;assert.equal(calls,8,'only already in-flight sends may finish');
 }finally{release?.();rmSync(dir,{recursive:true,force:true});}
});

test('editing a saved time window cannot send both an initial alert and a reopened alert for the same place',async()=>{
 const f=await fixture();try{
  f.observe(0);await flushSlotUpdates(f.store,f.api);
  f.store.replaceDayFilters(123,'17',f.date,[{date:f.date,startAfter:'15:30',notifyAvailable:true}]);
  f.observe(1);await Promise.all([flushOutbox(f.store,f.api),flushSlotUpdates(f.store,f.api)]);
  assert.equal(f.sent.filter(m=>m.text.startsWith('🟢 Yer açıldı')).length,1);
 }finally{f.close();}
});

test('legacy duplicate initial jobs already queued cannot replay an established session lifecycle',async()=>{
 const f=await fixture();try{
  f.store.state.outbox.push({id:'old-duplicate',chatId:'123',status:'queued',nextAt:0,attempts:0,event:{kind:'available',facility:{id:'17',label:'Baraka'},date:f.date,start:'16:00',end:'17:30',free:1,observedAt:new Date().toISOString()}});
  await flushOutbox(f.store,f.api);assert.equal(f.sent.length,0);assert.equal(f.store.state.outbox.find(i=>i.id==='old-duplicate').status,'cancelled');
 }finally{f.close();}
});


test('quarantining a bad day cannot refresh that day or issue Doldu when valid neighboring days are ingested',async()=>{
 const f=await fixture();try{
  const key='17|'+f.date,before=structuredClone(f.store.engine.pages[key]);
  const other=new Date(Date.parse(f.date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  f.observe(1,{dateOverride:other});f.observe(1,{dateOverride:other});
  await flushOutbox(f.store,f.api);await flushSlotUpdates(f.store,f.api);
  assert.deepEqual(f.store.engine.pages[key],before,'no fabricated empty/fresh observation for the quarantined day');
  assert.equal(f.sent.length,0);assert.equal(f.edited.length,0);assert.equal(f.alert().lastNotified,'available');
 }finally{f.close();}
});


test('interrupted slot delivery is recorded after restart and is never resent',async()=>{
 const f=await fixture();try{
  f.observe(0);const job=Object.values(f.store.state.slotStatusJobs)[0];job.notifyState='sending';f.store.save();
  const loaded=new LocalStore(f.store.file,{betaInviteCode:invite});
  assert.equal(loaded.state.slotUpdateUncertainCode,'interrupted');
  assert.ok(Number.isFinite(Date.parse(loaded.state.slotUpdateUncertainAt)));
  await flushSlotUpdates(loaded,f.api);await flushSlotUpdates(loaded,f.api);
  assert.equal(f.sent.length,0);assert.equal(loaded.state.slotUpdateUncertainCode,'interrupted');
 }finally{f.close();}
});

test('uncertain send reason is recorded safely without replay or raw errors',async t=>{
 const logs=[];t.mock.method(console,'error',line=>logs.push(line));
 for(const [error,code] of [
  [Object.assign(new Error('secret personal data'),{name:'TimeoutError'}),'timeout'],
  [Object.assign(new Error('secret personal data'),{status:503}),'http_5xx'],
  [Object.assign(new Error('secret personal data'),{status:408}),'http_408'],
  [Object.assign(new Error('secret personal data'),{status:200}),'invalid_response'],
  [new Error('secret personal data'),'network_or_unknown']]){
  const f=await fixture();let calls=0;try{
   f.observe(0);await flushSlotUpdates(f.store,{sendMessage:async()=>{calls++;throw error;}});
   assert.equal(f.store.state.slotUpdateUncertainCode,code);
   assert.ok(Number.isFinite(Date.parse(f.store.state.slotUpdateUncertainAt)));
   assert.equal(JSON.stringify(f.store.state).includes('secret personal data'),false);
   assert.match(logs.at(-1),new RegExp(`REZ_SLOT_DELIVERY uncertain ${code} attempt_ms=\\d+ response_timeout_ms=\\d+$`));
   assert.equal(logs.join('\n').includes('secret personal data'),false);
   await flushSlotUpdates(f.store,f.api);assert.equal(calls,1);assert.equal(f.sent.length,0);
  }finally{f.close();}
 }
});
