import {createOperatorChannel} from '../src/operator-alerts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalStore} from '../src/store.mjs';
import {handleBotCommand,handleBotCallback,formatAvailability,flushOutbox,TelegramApi,createMenuDispatcher,botCommands} from '../src/telegram.mjs';
import {dayMenu,sessionMenu,pickerDates} from '../src/telegram-picker.mjs';
import {formatSlotStatus,flushSlotUpdates} from '../src/slot-alerts.mjs';
import {checkCoverage,checkDeliveryHealth,checkTelegramPolling} from '../src/coverage.mjs';
import {withLanguage,msg,facilityLabel} from '../src/i18n.mjs';

function fixture(){
 const folder=mkdtempSync(join(tmpdir(),'rez-language-')),file=join(folder,'state.json');
 const store=new LocalStore(file,{accessMode:'public'});store.admitChat(123);store.admitChat(456);
 store.setFacilityCatalog([{id:'17',label:'Baraka Spor Salonu - Fitness Salonu',unit:'Spor Müdürlüğü'},{id:'21',label:'ODTÜ Spor Merkezi - Fitness Salonu',unit:'Spor Müdürlüğü'},{id:'1',label:'1 Nolu Açık Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'}]);
 const date=pickerDates().at(-1),stamp=new Date().toISOString();
 store.state.readerCapabilities={maxFacilities:200,catalogDiscovery:true,parallelRead:true};
 store.state.readerPlan={facilityIds:['17','21','1'],dates:[date],scanMode:'parallel'};store.state.readerState={phase:'ready'};
 const snapshot=(free=2)=>({schema:1,source:'rez-calendar-extension',fresh:true,refresh_id:`language-response-${Date.now()}-${free}`,observed_at:new Date().toISOString(),state:'ok',facility:{id:'17',label:'Baraka Spor Salonu - Fitness Salonu'},view:{type:'day',date},slots:[{date,start:'17:00',end:'18:30',free}]});
 return {store,file,date,stamp,snapshot,close:()=>rmSync(folder,{recursive:true,force:true})};
}
const command=(store,text,id=123)=>handleBotCommand(store,{chat:{id,type:'private'},text});
const callback=(store,data,id=123,extra={})=>handleBotCallback(store,{id:'callback-test',from:{id},message:{message_id:9,chat:{id,type:'private'}},data,...extra});
const buttons=reply=>reply.replyMarkup.inline_keyboard.flat();
const allText=reply=>[reply.text,...buttons(reply).map(b=>b.text)].join('\n');
const english=reply=>assert.doesNotMatch(allText(reply).replaceAll('Türkçe',''),/[çğıİöşüÇĞÖŞÜ]|Seçimler|kayıtlı|sonrası|öncesi|henüz/u);

test('Settings keeps language and tests; Support sits beside it on the home menu',()=>{
 const f=fixture();try{
  const home=command(f.store,'/menu');assert.ok(buttons(home).some(b=>b.text==='⚙️ Settings'));
  assert.ok(buttons(home).some(b=>b.callback_data==='c'));assert.equal(buttons(home).some(b=>b.callback_data==='test'),false);
  const settings=callback(f.store,'settings');assert.match(settings.text,/Settings/);assert.match(settings.text,/Dil: Türkçe/);
  assert.deepEqual(buttons(settings).filter(b=>b.callback_data.startsWith('lang:')).map(b=>b.text),['✅ Türkçe','English']);
  assert.equal(buttons(settings).some(b=>b.callback_data==='c'),false);assert.ok(buttons(settings).some(b=>b.callback_data==='test'));
  assert.ok(home.replyMarkup.inline_keyboard.some(row=>row.some(b=>b.callback_data==='settings')&&row.some(b=>b.callback_data==='c')));
  assert.equal(buttons(callback(f.store,'c')).some(b=>b.callback_data==='settings'),false);assert.ok(buttons(callback(f.store,'c')).some(b=>b.callback_data==='h'));
 }finally{f.close();}
});
test('changing language immediately renders Settings in the new language, persists per chat and preserves all selections',()=>{
 const f=fixture();try{
  f.store.subscribe(123,'17',{date:f.date,notifyAvailable:true});const prior=JSON.stringify(f.store.state.subscriptions);
  const en=callback(f.store,'lang:en');english(en);assert.match(en.text,/Language: English/);assert.equal(en.editMessageId,9);
  assert.equal(f.store.languageFor(123),'en');assert.equal(f.store.languageFor(456),'tr');assert.equal(JSON.stringify(f.store.state.subscriptions),prior);
  const restored=new LocalStore(f.file,{accessMode:'public'});assert.equal(restored.languageFor(123),'en');assert.equal(restored.languageFor(456),'tr');
  assert.match(command(restored,'/menu').text,/METU Reservation Tracker/);assert.match(command(restored,'/menu',456).text,/ODTÜ Rezervasyon Takip/);
  assert.match(callback(restored,'lang:tr').text,/Dil: Türkçe/);assert.match(command(restored,'/menu').text,/ODTÜ Rezervasyon Takip/);
 }finally{f.close();}
});
test('language choice cannot be forged for another chat, used from a group or set to an unsupported code',()=>{
 const f=fixture();try{
  assert.equal(callback(f.store,'lang:en',123,{from:{id:456}}),null);
  assert.equal(callback(f.store,'lang:en',123,{message:{message_id:9,chat:{id:123,type:'group'}}}),null);
  callback(f.store,'lang:de');assert.equal(f.store.languageFor(123),'tr');assert.equal(f.store.setLanguage(789,'en'),false);assert.equal(f.store.setLanguage(123,'de'),false);
  f.store.forgetChat(123);assert.equal(callback(f.store,'lang:en'),null);
 }finally{f.close();}
});
test('English covers the full directorate, facility, day, session, completion and selection flow',()=>{
 const f=fixture();try{
  f.store.setLanguage(123,'en');f.store.ingest(f.snapshot());
  const unit=command(f.store,'/facilities');english(unit);assert.match(allText(unit),/Sports Directorate/);
  const facility=callback(f.store,buttons(unit).find(b=>b.callback_data.startsWith('u:')).callback_data);english(facility);assert.match(allText(facility),/Court 1/);
  english(dayMenu(f.store,123,'17'));assert.doesNotMatch(allText(dayMenu(f.store,123,'17')),/Ekim|Kasım|Pazar/);
  const sessions=sessionMenu(f.store,123,'17',f.date);english(sessions);assert.match(sessions.text,/Choose the sessions/);
  const selected=callback(f.store,buttons(sessions).find(b=>b.callback_data.startsWith('q:')).callback_data);english(selected);
  assert.equal(buttons(selected).some(b=>b.callback_data.startsWith('done:')),false);assert.equal(selected.answerText,'✅ Saved');
  english(command(f.store,'/selections'));english(command(f.store,'/status'));english(command(f.store,'/support'));
  english(command(f.store,'/test'));english(command(f.store,'/test'));english(command(f.store,'/unknown'));english(command(f.store,'hello'));
 }finally{f.close();}
});
test('unknown and stale session screens remain English, including saved windows and whole-day selections',()=>{
 const f=fixture();try{
  f.store.setLanguage(123,'en');f.store.subscribe(123,'17',{date:f.date,startAfter:'15:30',endBefore:'23:59',notifyAvailable:true});
  english(sessionMenu(f.store,123,'17',f.date));assert.match(sessionMenu(f.store,123,'17',f.date).text,/After 15:30/);
  callback(f.store,`da:17:${f.date.replaceAll('-','')}:1`);english(sessionMenu(f.store,123,'17',f.date));
  assert.match(sessionMenu(f.store,123,'17',f.date).text,/All sessions for this day are selected/);
  f.store.state.readerCapabilities={maxFacilities:2};english(dayMenu(f.store,123,'1'));english(sessionMenu(f.store,123,'1',f.date));
  delete f.store.state.readerPlan;english(command(f.store,'/menu'));english(command(f.store,'/status'));
 }finally{f.close();}
});
test('queued vacancies and subsequent full status use each recipient language at delivery time',async()=>{
 const f=fixture();try{
  f.store.state.fastAvailability=true;
  f.store.subscribe(123,'17',{date:f.date,notifyAvailable:true});f.store.subscribe(456,'17',{date:f.date,notifyAvailable:true});
  f.store.ingest(f.snapshot());assert.equal(f.store.status().queued,2);f.store.setLanguage(123,'en');
  const sent=[],edits=[],api={sendMessage:async(id,text)=>{sent.push({id:String(id),text});return{message_id:sent.length+10};},editMessageText:async(id,_mid,text)=>edits.push({id:String(id),text})};
  await flushOutbox(f.store,api);assert.match(sent.find(x=>x.id==='123').text,/place is available/);assert.match(sent.find(x=>x.id==='456').text,/Yer açıldı/);
  f.store.ingest(f.snapshot(0));await flushSlotUpdates(f.store,api);
  // A full session is a new short message in each recipient's language; nothing is edited.
  assert.equal(edits.length,0);assert.match(sent.filter(x=>x.id==='123').at(-1).text,/^🔴 Full now/);assert.match(sent.filter(x=>x.id==='456').at(-1).text,/^🔴 Doldu/);
 }finally{f.close();}
});
test('all vacancy and slot lifecycle messages have English wording and dates',()=>{
 const e={kind:'reappeared',facility:{label:'1 Nolu Açık Tenis Kortu (Büyük Spor Salonu)'},date:'2026-11-01',start:'17:00',end:'18:00',free:1};
 english({text:formatAvailability(e,'en'),replyMarkup:{inline_keyboard:[]}});
 for(const lang of ['tr','en']){
  for(const text of [formatAvailability(e,lang),formatSlotStatus({...e,status:'available'},e.facility.label,lang)]){assert.equal(text.split('\n').length,2);assert.match(text.split('\n')[0],lang==='tr'?/Boş yer: 1$/:/Free places: 1$/);assert.match(text.split('\n')[1],/17:00–18:00/);}
 }
 for(const status of ['available','full','unlisted','checking','stale','expired']){
  const text=formatSlotStatus({...e,status,observedAt:new Date().toISOString()},e.facility.label,'en');english({text,replyMarkup:{inline_keyboard:[]}});assert.ok(text.split('\n').length<=2,'short');assert.match(text,/17:00–18:00/);
 }
});
test('technical coverage, delivery and polling notices respect the owner language',async()=>{
 for(const kind of ['coverage','delivery','polling']){
  const f=fixture();try{
   f.store.setLanguage(123,'en');const now=Date.now(),sent=[],api=createOperatorChannel({sendMessage:async(_id,text)=>sent.push(text)},123);
   if(kind==='coverage'){f.store.state.readerState={phase:'site_access_denied'};f.store.state.coverageNotice={kind:'site_access_denied',since:now-130000,alerted:false};await checkCoverage(f.store,api,123,now);}
   if(kind==='delivery'){f.store.state.outbox.push({id:'language-failure',status:'failed',failedAt:new Date(now).toISOString()});await checkDeliveryHealth(f.store,api,123,now);}
   if(kind==='polling'){f.store.setTelegramConfigured(true);f.store.telegramHealth.startedAt=new Date(now-300000).toISOString();await checkTelegramPolling(f.store,api,123,now);}
   assert.equal(sent.length,1);english({text:sent[0],replyMarkup:{inline_keyboard:[]}});
  }finally{f.close();}
 }
});
test('language contexts remain isolated across overlapping asynchronous work',async()=>{
 const values=await Promise.all([withLanguage('en',async()=>{await delay(15);return msg('Türkçe','English');}),withLanguage('tr',async()=>{await delay(5);return msg('Türkçe','English');})]);
 assert.deepEqual(values,['English','Türkçe']);assert.equal(msg('Türkçe','English'),'Türkçe');
});
test('delete replies in the selected language and removes the stored language together with selections',()=>{
 const f=fixture();try{f.store.setLanguage(123,'en');f.store.subscribe(123,'17',{date:f.date,notifyAvailable:true});const result=command(f.store,'/delete');assert.match(result.text,/have been deleted/);assert.equal(f.store.state.chatLanguages['123'],undefined);assert.equal(f.store.subscriptionsFor(123).length,0);assert.equal(f.store.isChatAllowed(123),false);}finally{f.close();}
});
test('only supported language codes for approved chats survive a state reload',()=>{
 const f=fixture();try{const s=JSON.parse(readFileSync(f.file));s.chatLanguages={'123':'en','456':'de','789':'en'};writeFileSync(f.file,JSON.stringify(s));const restored=new LocalStore(f.file,{accessMode:'public'});assert.deepEqual(restored.state.chatLanguages,{'123':'en'});}finally{f.close();}
});
test('Telegram native commands are scoped to the language-changing chat and include Settings',async()=>{
 const f=fixture();try{
  let payload;const api=new TelegramApi('12345678:'+ 'A'.repeat(32),async(_url,options)=>{payload=JSON.parse(options.body);return{ok:true,status:200,json:async()=>({ok:true,result:true})};});
  await api.setChatCommands(123,'en');assert.deepEqual(payload.scope,{type:'chat',chat_id:123});assert.ok(payload.commands.some(x=>x.command==='settings'));assert.match(payload.commands.find(x=>x.command==='settings').description,/Language/);
  assert.match(botCommands('tr').find(x=>x.command==='settings').description,/Dil/);
  const called=[],d=createMenuDispatcher(f.store,{editMessageText:async()=>{},setChatCommands:async(...args)=>called.push(args)});
  d.enqueue(callback(f.store,'lang:en'));await d.drain();assert.deepEqual(called,[[123,'en']]);
 }finally{f.close();}
});
test('official facility labels translate known sports terms without changing the underlying catalogue',()=>{
 const labels=JSON.parse(readFileSync(new URL('../data/facilities-2026-10-18.json',import.meta.url))).facilities;
 assert.equal(labels.length,32);
 for(const f of labels){assert.doesNotMatch(withLanguage('en',()=>facilityLabel(f.label)),/[çğıİöşüÇĞÖŞÜ]|Nolu|Salonu/u);}
 assert.equal(withLanguage('en',()=>facilityLabel('Havuz Müdürlüğü')),'Swimming Pool Directorate');
 assert.equal(withLanguage('en',()=>facilityLabel('ODTÜ Spor Merkezi - 1 Nolu Salon')),'METU Sports Centre - 1 Hall');
});

test('a slow native command update never delays the next inline-menu tap',async()=>{
 const f=fixture();let release;const gate=new Promise(r=>release=r);try{
  const visible=[],d=createMenuDispatcher(f.store,{editMessageText:async(_chat,_id,text)=>visible.push(text),setChatCommands:async()=>gate});
  d.enqueue(callback(f.store,'lang:en'));await delay(0);d.enqueue(callback(f.store,'h'));await delay(0);
  assert.equal(visible.length,2);assert.match(visible[1],/METU Reservation Tracker/);release();await d.drain();
 }finally{release?.();f.close();}
});
test('deleting preferences also clears the native per-chat command language',async()=>{
 const f=fixture();try{
  f.store.setLanguage(123,'en');const cleared=[],d=createMenuDispatcher(f.store,{sendMessage:async()=>{},clearChatCommands:async id=>cleared.push(id)});
  d.enqueue(command(f.store,'/delete'));await d.drain();assert.deepEqual(cleared,[123]);
 }finally{f.close();}
});

test('TR and EN home menus expose facility selection, My selections, Settings and Support',()=>{
 const f=fixture();try{
  for(const language of ['tr','en']){
   f.store.setLanguage(123,language);
   const home=command(f.store,'/menu');assert.deepEqual(buttons(home).map(b=>b.callback_data),['u','p','settings','c']);
   assert.equal(botCommands(language).some(c=>c.command==='status'),false);
   const retired=callback(f.store,'m:start');assert.deepEqual(buttons(retired).map(b=>b.callback_data),['u','p','settings','c']);
  }
 }finally{f.close();}
});

test('closed pools are labelled Soon without a fictitious facility, and discovered pools replace the placeholder',()=>{
 const f=fixture();try{
  const before=JSON.stringify(f.store.state.subscriptions);
  for(const language of ['tr','en']){
   f.store.setLanguage(123,language);const menu=command(f.store,'/facilities');
   const pool=buttons(menu).filter(b=>b.callback_data==='soon:pool');assert.equal(pool.length,1);assert.match(pool[0].text,/\(Soon\)$/);
   if(language==='en')english(menu);
   const closed=callback(f.store,'soon:pool');assert.match(closed.answerText,language==='tr'?/Tadilat/:/renovations/);
   assert.equal(JSON.stringify(f.store.state.subscriptions),before);
  }
  f.store.setFacilityCatalog([...f.store.availableFacilities(),{id:'31',label:'Açık Havuz',unit:'Havuz Müdürlüğü'}]);
  const open=command(f.store,'/facilities');assert.equal(buttons(open).some(b=>b.callback_data==='soon:pool'),false);
  assert.ok(buttons(open).some(b=>/Pool Directorate/.test(b.text)));
  const old=callback(f.store,'soon:pool');assert.ok(buttons(old).some(b=>b.callback_data==='t:31'));
  assert.equal(JSON.stringify(f.store.state.subscriptions),before);
 }finally{f.close();}
});
