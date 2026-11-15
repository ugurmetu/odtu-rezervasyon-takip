import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {redirectReply} from '../src/legacy-redirect.mjs';
import {LocalStore} from '../src/store.mjs';
import {handleBotCommand,handleBotCallback} from '../src/telegram.mjs';
import {handlePickerCallback,pickerDates} from '../src/telegram-picker.mjs';
import {validateBotStartup,startLocalServer} from '../src/server.mjs';
const token='123456789:'+ 'a'.repeat(35),invite='test_public_invite_2026';
const msg=(id,text)=>({chat:{id,type:'private'},text,from:{id,username:'should_not_be_saved',first_name:'not_saved'}});
const cb=(id,data)=>({id:'callback',from:{id},message:{chat:{id,type:'private'},message_id:1},data});
const data=r=>r.replyMarkup?.inline_keyboard.flat().map(b=>b.callback_data)||[];
function fixture(options={}){
 const dir=mkdtempSync(join(tmpdir(),'rez-public-')),store=new LocalStore(join(dir,'state.json'),{accessMode:'public',...options});
 const date=pickerDates()[0],future=pickerDates().at(-1);
 store.setFacilityCatalog([{id:'17',label:'Baraka Spor Salonu - Fitness Salonu',unit:'Spor Müdürlüğü'},{id:'21',label:'ODTÜ Spor Merkezi - Fitness Salonu',unit:'Spor Müdürlüğü'},{id:'3',label:'3 Nolu Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'}]);
 store.state.readerPlan={facilityIds:['17','21'],dates:[date]};store.state.readerState={phase:'ready'};
 for(const id of ['17','21'])store.engine.pages[`${id}|${date}`]={lastSuccessAt:new Date().toISOString()};
 return {store,date,future,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('public opt-in accepts plain and old deep-link start, persists minimal IDs, and never enrolls arbitrary updates',()=>{
 const f=fixture();try{
  assert.equal(handleBotCommand(f.store,msg(123,'/menu')),null);assert.equal(f.store.isChatAllowed(123),false);
  assert.match(handleBotCommand(f.store,msg(123,'/start')).text,/Seçtiğin seansta yer açılınca haber veririm/);
  assert.match(handleBotCommand(f.store,msg(456,'/start old_invite_link')).text,/ODTÜ Rezervasyon Takip/);
  assert.equal(handleBotCommand(f.store,{chat:{id:-123,type:'group'},text:'/start'}),null);
  assert.equal(handleBotCallback(f.store,cb(789,'h')),null);
  const saved=readFileSync(f.store.file,'utf8');assert.doesNotMatch(saved,/should_not_be_saved|not_saved|old_invite_link/);
  const loaded=new LocalStore(f.store.file,{accessMode:'public'});assert.equal(loaded.isChatAllowed(123),true);assert.equal(loaded.isChatAllowed(789),false);
 }finally{f.close();}
});
test('public mode is explicit; invite mode and missing-config fail-closed behavior remain intact',()=>{
 const f=fixture({accessMode:'invite',betaInviteCode:invite});try{
  assert.equal(f.store.admitChat(123), 'invalid');assert.equal(f.store.isChatAllowed(123),false);
  assert.equal(f.store.admitChat(123,invite),'approved');
  assert.throws(()=>validateBotStartup(token,''),/invite code/);
  assert.doesNotThrow(()=>validateBotStartup(token,'','public'));
  assert.throws(()=>validateBotStartup(token,'','pubic'),/access mode/);
  assert.throws(()=>validateBotStartup('invalid','','public'),/invalid Telegram/);
  assert.equal(new LocalStore(f.store.file).isChatAllowed(123),false);
 }finally{f.close();}
});
test('public admission stays bounded, idempotent, and private-only',()=>{
 const f=fixture({publicMaxChats:2});try{
  assert.equal(f.store.admitChat(-123),'invalid');assert.equal(f.store.admitChat('9007199254740992'),'invalid');
  for(const id of [123,456,123])assert.equal(f.store.admitChat(id),'approved');
  assert.equal(f.store.admitChat(789),'full');assert.equal(f.store.state.betaApprovedChatIds.length,2);
 }finally{f.close();}
});
test('retired status command shows selections without disclosing reader state or changing the plan',()=>{
 const f=fixture();try{
  f.store.admitChat(123);for(const id of ['17','21','3'])f.store.subscribe(123,id,{date:f.date,notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions),expected=handleBotCommand(f.store,msg(123,'/selections'));
  assert.match(expected.text,/Baraka Fitness/);assert.match(expected.text,/Teknokent Fitness/);assert.match(expected.text,/3\. Kort · Büyük Spor/);
  for(const phase of ['ready','signing_in','waiting_verification','network_wait']){
   f.store.state.readerState.phase=phase;
   for(const command of ['/durum','/status']){const r=handleBotCommand(f.store,msg(123,command));assert.equal(r.text,expected.text);assert.deepEqual(r.replyMarkup,expected.replyMarkup);}
   assert.equal(f.store.state.readerState.phase,phase);
  }
  f.store.state.readerPlan.dates=['2099-01-01'];assert.equal(handleBotCommand(f.store,msg(123,'/durum')).text,expected.text);
  assert.equal(JSON.stringify(f.store.state.subscriptions),before);assert.deepEqual(f.store.state.readerPlan.facilityIds,['17','21']);
 }finally{f.close();}
});
test('public facilities advertise only monitored choices; old callbacks cannot silently enroll unsupported facilities or days',()=>{
 const f=fixture();try{
  f.store.admitChat(123);const units=handleBotCommand(f.store,msg(123,'/tesisler'));
  const facilities=handleBotCallback(f.store,cb(123,data(units).find(x=>x.startsWith('u:'))));
  assert.ok(data(facilities).includes('t:17'));assert.ok(data(facilities).includes('t:21'));assert.ok(!data(facilities).includes('t:3'));
  assert.match(handleBotCallback(f.store,cb(123,'t:3')).text,/henüz takip edilmiyor/);
  const code=f.date.replaceAll('-','');handlePickerCallback(f.store,123,`da:3:${code}:1`);assert.equal(f.store.filtersFor(123,'3').length,0);
  f.store.state.readerPlan.dates=[];handlePickerCallback(f.store,123,`da:17:${code}:1`);assert.equal(f.store.filtersFor(123,'17').length,0);
  f.store.subscribe(123,'3',{date:f.date,notifyAvailable:true});handlePickerCallback(f.store,123,`dx:3:${code}`);assert.equal(f.store.filtersFor(123,'3').length,0);
 }finally{f.close();}
});
test('forget removes only the calling person and their pending/sent alert associations; restart does not restore access',()=>{
 const f=fixture();try{
  for(const id of [123,456]){f.store.admitChat(id);f.store.subscribe(id,'17',{date:f.date});}
  f.store.state.slotAlerts={own:{chatId:'123'},other:{chatId:'456',date:f.date}};f.store.state.slotStatusJobs={own:{},other:{}};
  f.store.state.outbox=[{chatId:'123',status:'sent'},{chatId:'456',status:'sent',sentAt:new Date().toISOString()}];
  assert.match(handleBotCommand(f.store,msg(123,'/sil')).text,/silindi/);
  assert.equal(f.store.isChatAllowed(123),false);assert.equal(f.store.isChatAllowed(456),true);assert.equal(f.store.subscriptionsFor(123).length,0);assert.equal(f.store.subscriptionsFor(456).length,1);
  assert.deepEqual(Object.keys(f.store.state.slotAlerts),['other']);assert.deepEqual(Object.keys(f.store.state.slotStatusJobs),['other']);assert.equal(f.store.state.outbox.length,1);
  assert.equal(new LocalStore(f.store.file,{accessMode:'public'}).isChatAllowed(123),false);
 }finally{f.close();}
});
test('public Telegram admission never exposes the loopback reader or credential endpoint',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-public-http-')),key='a'.repeat(64);let local;
 try{local=await startLocalServer({port:0,key,stateFile:join(dir,'state.json'),accessMode:'public'});
  local.store.admitChat(123);
  for(const path of ['/health','/session/credentials'])assert.equal((await fetch(local.url+path)).status,403);
  const health=await(await fetch(local.url+'/health',{headers:{'X-Local-Key':key}})).json();assert.equal(health.accessMode,'public');assert.equal(local.server.address().address,'127.0.0.1');
 }finally{if(local)await local.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy bot points to the new plain public link without carrying an invite or enrolling the user',()=>{
 const reply=redirectReply({message:{chat:{id:123,type:'private'},text:'/start'}});
 assert.equal(reply.replyMarkup.inline_keyboard[0][0].url,'https://t.me/odtu_rezervasyon_bot');
 assert.doesNotMatch(reply.text,/start=|davet/);
 assert.equal(redirectReply({message:{chat:{id:-123,type:'group'},text:'/start'}}),null);
 assert.equal(redirectReply({callback_query:{from:{id:456},message:{chat:{id:123,type:'private'}}}}),null);
});

test('old saved choices stay editable without technical health labels or a Status action',()=>{
 const f=fixture();try{
  f.store.admitChat(123);for(const id of ['17','21','3'])f.store.subscribe(123,id,{date:f.date,notifyAvailable:true});
  const r=handleBotCommand(f.store,msg(123,'/izlediklerim'));assert.match(r.text,/3\. Kort · Büyük Spor/);assert.doesNotMatch(r.text,/Bazı salon|Bazı seçimler|aksıyor|Henüz takip edilmiyor|Takip ediliyor|📡/);
  assert.equal(data(r).includes('s'),false);assert.ok(data(r).some(d=>d?.startsWith('px:')));
  assert.ok(r.text.split('\n').every(line=>line.length<=45));
 }finally{f.close();}
});

test('capable tennis reader offers courts, requests one shared calendar on browse and accepts dated choices without invented sessions',()=>{
 const f=fixture();try{f.store.state.readerCapabilities={version:'0.6.0',maxFacilities:16};f.store.admitChat(123);
 const menu=handleBotCommand(f.store,msg(123,'/izle 3'));assert.match(menu.text,/Hangi gün/);assert.ok(f.store.state.readerRequests['3']);
 const code=f.date.replaceAll('-','');const view=handlePickerCallback(f.store,123,`d:3:${code}`);assert.match(view.text,/eklendi · bütün seanslar/);assert.doesNotMatch(JSON.stringify(view),/06:00|Sabah|doğrulanamadı/);
 assert.ok(data(view).includes(`d:3:${code}`));handlePickerCallback(f.store,123,`da:3:${code}:1`);assert.equal(f.store.filtersFor(123,'3').length,1);
 assert.equal(f.store.filtersFor(123,'17').length,0);assert.equal(f.store.filtersFor(123,'21').length,0);
 }finally{f.close();}
});

test('the operator can queue only a supported court, without faking a snapshot or opening the reader endpoint publicly',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-request-')),key='a'.repeat(64);let local;
 try{local=await startLocalServer({port:0,key,stateFile:join(dir,'state.json'),accessMode:'public'});local.store.setFacilityCatalog([{id:'1',label:'1 Nolu Açık Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'}]);
  const opts={method:'POST',headers:{'Content-Type':'application/json','X-Local-Key':key},body:JSON.stringify({facilityId:'1'})};
  assert.equal((await fetch(local.url+'/reader-request',{...opts,headers:{'Content-Type':'application/json'}})).status,403);
  const r=await(await fetch(local.url+'/reader-request',opts)).json();assert.equal(r.ok,true);assert.equal(r.scheduled,false);assert.ok(local.store.state.readerRequests['1']);assert.equal(local.store.state.outbox.length,0);assert.equal(Object.keys(local.store.engine.pages).length,0);
  assert.equal((await fetch(local.url+'/reader-request',{...opts,body:JSON.stringify({facilityId:'9999'})})).status,400);
 }finally{if(local)await local.close();rmSync(dir,{recursive:true,force:true});}
});

test('a complete global discovery updates names, adds pool, retires missing facilities and preserves user choices',()=>{const f=fixture();try{f.store.admitChat(123);f.store.subscribe(123,'3',{date:f.date});f.store.mergeDiscoveredCatalog({facilities:[{id:'17',label:'Yeni Baraka',unit:'Spor Müdürlüğü'},{id:'49',label:'Kapalı Havuz',unit:'Havuz Müdürlüğü',unitId:'2'}],units:[{id:'2',label:'Havuz Müdürlüğü'}],complete:true});assert.equal(f.store.catalogFacility('17').label,'Yeni Baraka');assert.equal(f.store.catalogFacility('3').enabled,false);assert.equal(f.store.catalogFacility('49').unitId,'2');assert.equal(f.store.filtersFor(123,'3').length,1);assert.equal(f.store.state.unitCatalog[0].label,'Havuz Müdürlüğü');}finally{f.close();}});
test('unit-scoped discovery never erases another directorate and invalid discoveries are atomic',()=>{const f=fixture();try{f.store.mergeDiscoveredCatalog({facilities:[{id:'49',label:'Havuz',unit:'Havuz Müdürlüğü',unitId:'2'}],complete:true,unitId:'2'});assert.notEqual(f.store.catalogFacility('17').enabled,false);const before=JSON.stringify(f.store.state.facilityCatalog);assert.throws(()=>f.store.mergeDiscoveredCatalog({facilities:[{id:'51',label:'Yeni',unit:'Havuz Müdürlüğü'},{id:'51',label:'Çakışma',unit:'Havuz Müdürlüğü'}],complete:true}),/invalid/);assert.equal(JSON.stringify(f.store.state.facilityCatalog),before);f.store.mergeDiscoveredCatalog({facilities:[],complete:false});assert.equal(JSON.stringify(f.store.state.facilityCatalog),before);}finally{f.close();}});
