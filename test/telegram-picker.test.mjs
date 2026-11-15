import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {subscriptionMatches} from '../src/core.mjs';
import {dayMenu,sessionMenu,sessionOptions,pickerDates,handlePickerCallback,facilityEmoji} from '../src/telegram-picker.mjs';
import {handleBotCallback,handleBotCommand,botCommands,runTelegramLoop} from '../src/telegram.mjs';
import {handleMultiPickerCallback} from '../src/telegram-multi-picker.mjs';
const now=Date.parse('2026-10-28T10:00:00Z'),day='2026-10-29',code='20261029';
const buttons=r=>r.replyMarkup.inline_keyboard.flat();
function fixture(){
 const folder=mkdtempSync(join(tmpdir(),'rez-picker-'));
 const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_picker_invite_2026'});
 store.approveBetaChat(123,'test_picker_invite_2026');store.approveBetaChat(456,'test_picker_invite_2026');
 store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'},
  {id:'21',label:'ODTÜ Spor Merkezi - Fitness Salonu',unit:'Spor Müdürlüğü'},
  {id:'5',label:'Padel Kort 1',unit:'Spor Müdürlüğü'}]);
 for(const [id,date,start,end] of [['17',day,'16:00','17:40'],['17',day,'18:00','19:45'],
  ['17','2026-10-30','09:00','10:15'],['21',day,'17:30','19:00'],['5',day,'20:00','21:00']]){
   const page=store.engine.pages[`${id}|${date}`]||={facility:{id},date,lastSuccessAt:new Date(now).toISOString(),baselineConfirmed:true,slots:{},observedSlotKeys:[]};
   const key=`${date}|${start}|${end}`;page.slots[key]={free:2};page.observedSlotKeys.push(key);
 }
 store.state.readerPlan={facilityIds:['17','21'],dates:[day,'2026-10-30']};
 return {store,close(){rmSync(folder,{recursive:true,force:true});}};
}
test('facility selection asks for a date and never offers synthetic morning/evening sessions',()=>{
 const f=fixture();try{
  const menu=dayMenu(f.store,123,'21',now);
  assert.match(menu.text,/Hangi gün/);assert.equal(buttons(menu).filter(b=>b.callback_data.startsWith('d:')).length,5);
  assert.doesNotMatch(JSON.stringify(menu),/06:00|Sabah|Öğleden sonra|Akşam/);
  assert.ok(buttons(menu).some(b=>b.callback_data==='back:21'));
 }finally{f.close();}
});
test('sessions belong to the selected facility and day, with their exact original duration',()=>{
 const f=fixture();try{
  assert.deepEqual(sessionOptions(f.store,'17',day,now).map(s=>[s.start,s.end]),[['16:00','17:40'],['18:00','19:45']]);
  assert.deepEqual(sessionOptions(f.store,'21',day,now).map(s=>[s.start,s.end]),[['17:30','19:00']]);
  assert.deepEqual(sessionOptions(f.store,'5',day,now).map(s=>[s.start,s.end]),[['20:00','21:00']]);
  assert.doesNotMatch(JSON.stringify(sessionMenu(f.store,123,'17',day,now)),/09:00|17:30/);
  assert.equal(facilityEmoji('Masa Tenisi'),'🏓');assert.equal(facilityEmoji('Padel Kort 1'),'🎾');
  assert.equal(facilityEmoji('Fitness'),'🏋️');
 }finally{f.close();}
});
test('unknown dates and inactive calendars do not claim full sessions or active coverage',()=>{
 const f=fixture();try{
  const empty=sessionMenu(f.store,123,'5','2026-10-30',now);
  assert.match(empty.text,/seans listesi henüz doğrulanmadı/);assert.match(empty.text,/şu an taranmıyor/);
  assert.equal(buttons(empty).filter(b=>b.callback_data.startsWith('q:')).length,0);
  const recent=sessionMenu(f.store,123,'17',day,now+5*60000);
  assert.doesNotMatch(recent.text,/yenileniyor|güncel değil/);assert.ok(buttons(recent).some(b=>/🟢 2 boş/.test(b.text)));
  const stale=sessionMenu(f.store,123,'17',day,now+16*60000);
  assert.match(stale.text,/Seanslar yenileniyor/);assert.doesNotMatch(stale.text,/⚠️/);assert.doesNotMatch(JSON.stringify(stale.replyMarkup),/son görülen|🟢/);
 }finally{f.close();}
});
test('multiple exact sessions preserve other dates, facilities, chats and delivery history',()=>{
 const f=fixture();try{
  const s=f.store;s.subscribe(123,'17',{date:'2026-10-30',startAfter:'15:30',notifyAvailable:true});
  s.filtersFor(123,'17')[0].availabilityChecks={kept:{deliveredId:'prior'}};
  s.subscribe(123,'21',{date:day,notifyAvailable:true});s.subscribe(456,'17',{date:day,notifyAvailable:true});
  handlePickerCallback(s,123,`q:17:${code}:16001740:1`,now);
  handlePickerCallback(s,123,`q:17:${code}:18001945:1`,now);
  s.filtersFor(123,'17').find(f=>f.date===day&&f.startAfter==='16:00').availabilityChecks={kept:{deliveredId:'same'}};
  handlePickerCallback(s,123,`q:17:${code}:16001740:1`,now);
  assert.equal(s.filtersFor(123,'17').filter(f=>f.date===day).length,2);
  assert.equal(s.filtersFor(123,'17').find(f=>f.startAfter==='16:00').availabilityChecks.kept.deliveredId,'same');
  handlePickerCallback(s,123,`q:17:${code}:16001740:0`,now);
  assert.equal(s.filtersFor(123,'17').filter(f=>f.date===day).length,1);
  assert.equal(s.filtersFor(123,'17').find(f=>f.date==='2026-10-30').availabilityChecks.kept.deliveredId,'prior');
  assert.equal(s.filtersFor(123,'21').length,1);assert.equal(s.filtersFor(456,'17').length,1);
  const chosen=s.filtersFor(123,'17').find(f=>f.date===day);
  assert.equal(subscriptionMatches(chosen,{facility:{id:'17'},date:day,start:'18:00',end:'19:45'}),true);
  assert.equal(subscriptionMatches(chosen,{facility:{id:'17'},date:day,start:'18:15',end:'19:30'}),false);
  handlePickerCallback(s,123,`q:17:${code}:18001945:0`,now);
  assert.equal(s.filtersFor(123,'17').filter(f=>f.date===day).length,0);
 }finally{f.close();}
});
test('forged hours cannot create preferences and whole-day follow is explicitly dated',()=>{
 const f=fixture();try{
  handlePickerCallback(f.store,123,`q:17:${code}:06001300:1`,now);
  assert.equal(f.store.filtersFor(123,'17').length,0);
  handlePickerCallback(f.store,123,`da:17:${code}:1`,now);
  const filter=f.store.filtersFor(123,'17')[0];assert.equal(filter.date,day);assert.equal(filter.notifyAvailable,true);
  handlePickerCallback(f.store,123,`q:17:${code}:16001740:1`,now);
  assert.equal(f.store.filtersFor(123,'17').length,1);assert.equal(f.store.filtersFor(123,'17')[0].exactTime,true);
 }finally{f.close();}
});
test('old Telegram time buttons navigate safely without overwriting dated preferences',()=>{
 const f=fixture();try{
  f.store.subscribe(123,'17',{date:day,startAfter:'15:30',notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions);
  for(const data of ['a:17','w:17:06001300:1','t:17']){
   const menu=handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data});
   assert.match(menu.text,/Hangi gün/);assert.equal(JSON.stringify(f.store.state.subscriptions),before);
  }
 }finally{f.close();}
});
test('Istanbul date rolls at midnight, never using the UTC previous day',()=>{
 assert.equal(pickerDates(Date.parse('2026-10-28T21:05:00Z'))[0],'2026-10-29');
 assert.equal(pickerDates(Date.parse('2026-10-31T21:05:00Z'))[0],'2026-11-01');
});
test('midweek dates stop on Sunday across month and year boundaries',()=>{
 assert.deepEqual(pickerDates(now),['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
 assert.deepEqual(pickerDates(Date.parse('2026-12-30T08:00:00Z')),['2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
});
test('Sunday switches to next Monday-Sunday at 19:30 Istanbul, before the evening publication',()=>{
 assert.deepEqual(pickerDates(Date.parse('2026-11-01T16:29:59Z')),['2026-11-01']);
 const next=pickerDates(Date.parse('2026-11-01T16:30:00Z'));
 assert.equal(next.length,7);assert.equal(next[0],'2026-11-02');assert.equal(next.at(-1),'2026-11-08');
});
test('an old next-week button cannot create a watch before the week opens',()=>{
 const f=fixture();try{
  const before=JSON.stringify(f.store.state.subscriptions);
  for(const data of ['d:17:20261102','da:17:20261102:1','q:17:20261102:16001740:1']){
   const menu=handlePickerCallback(f.store,123,data,now);assert.match(menu.text,/Hangi gün/);
   assert.equal(JSON.stringify(f.store.state.subscriptions),before);
  }
 }finally{f.close();}
});

// Full sessions must remain selectable independently of the vacancy calendar.
test('official dated session list includes a full or unseen session without inventing availability',()=>{
 const f=fixture();try{
  f.store.setSessionCatalog('17',day,[{start:'08:00',end:'09:30'},{start:'10:00',end:'11:30'}],new Date(now).toISOString());
  const options=sessionOptions(f.store,'17',day,now);
  assert.deepEqual(options.map(s=>[s.start,s.end,s.free]),[['08:00','09:30',null],['10:00','11:30',null]]);
  assert.doesNotMatch(JSON.stringify(sessionMenu(f.store,123,'17',day,now)),/16:00|18:00|son görülen/);
  assert.deepEqual(sessionOptions(f.store,'17','2026-10-30',now).map(s=>s.start),['09:00']);
  handlePickerCallback(f.store,123,`q:17:${code}:08000930:1`,now);
  assert.equal(f.store.filtersFor(123,'17')[0].startAfter,'08:00');
  const loaded=new LocalStore(f.store.file,{betaInviteCode:'test_picker_invite_2026'});
  assert.equal(sessionOptions(loaded,'17',day,now).length,2);
 }finally{f.close();}
});
test('catalog cannot manufacture vacancy counts or change saved time preferences',()=>{
 const f=fixture();try{
  f.store.subscribe(123,'17',{date:day,startAfter:'15:30',notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions);
  f.store.setSessionCatalog('17',day,[{start:'08:00',end:'09:30'}],new Date(now).toISOString());
  const menu=sessionMenu(f.store,123,'17',day,now);
  assert.match(menu.text,/tercihine uyan saat yok/);
  assert.equal(JSON.stringify(f.store.state.subscriptions),before);
  assert.throws(()=>f.store.setSessionCatalog('17',day,[{start:'18:00',end:'09:30'}]),/invalid/);
  assert.throws(()=>f.store.setSessionCatalog('999',day,[]),/invalid/);
  assert.equal(f.store.status().queued,0);
 }finally{f.close();}
});

test('whole-day selection clearly offers switching to one hour instead of showing unchecked selected hours',()=>{
 const f=fixture();try{
  f.store.subscribe(123,'17',{date:day,notifyAvailable:true});
  const menu=sessionMenu(f.store,123,'17',day,now);
  assert.ok(buttons(menu).find(b=>b.text.startsWith('Yalnız 16:00–17:40 · 🟢 2 boş')));
  handlePickerCallback(f.store,123,`q:17:${code}:16001740:1`,now);
  assert.equal(f.store.filtersFor(123,'17').length,1);
  assert.equal(f.store.filtersFor(123,'17')[0].exactTime,true);
 }finally{f.close();}
});

test('my selections fit on one screen: one line per day with all its times, no pages or coverage fractions',()=>{
 const f=fixture();try{
  // Istanbul calendar days: after midnight there the UTC date is still the day before.
  const iso=offset=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(Date.now()+offset*86400000));
  for(const id of ['17','21'])for(const offset of [0,1,2])f.store.subscribe(123,id,{date:iso(offset),startAfter:'15:30',notifyAvailable:true});
  for(let hour=6;hour<14;hour++)f.store.subscribe(123,'17',{date:iso(1),startAfter:`${hour.toString().padStart(2,'0')}:00`,endBefore:`${(hour+1).toString().padStart(2,'0')}:00`,exactTime:true,notifyAvailable:true});
  f.store.subscribe(123,'21',{date:iso(-3),startAfter:'10:00',notifyAvailable:true});
  const cb=data=>handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data});
  const menu=cb('p');assert.match(menu.text,/Baraka Fitness/);assert.match(menu.text,/Teknokent Fitness/);assert.doesNotMatch(menu.text,/3\/6|gün takvimi|aralığındaki seanslar|güncel takip doğrulanmıyor|1\/2/);
  assert.match(menu.text,/yer açılınca haber veririm/);assert.ok(menu.text.split('\n').every(line=>line.length<=45));
  const dayLines=menu.text.split('\n').filter(line=>line.startsWith('• '));
  assert.equal(dayLines.length,6,'past days are hidden; each remaining day has one entry');
  assert.match(menu.text,/06:00–07:00/);assert.match(menu.text,/13:00–14:00/);
  assert.equal(buttons(menu).some(b=>/^p:\d/.test(b.callback_data||'')),false);
  assert.equal(buttons(menu).filter(b=>b.url).length,1);assert.ok(buttons(menu).some(b=>b.url==='https://rez.metu.edu.tr/'));
  assert.equal(cb('p:1').text,menu.text,'an old page button opens the same single screen');
 }finally{f.close();}
});
test('support is contact only in TR/EN; retention and deletion instructions are absent',()=>{
 const f=fixture(),oldEmail=process.env.REZ_SUPPORT_EMAIL,oldLinkedIn=process.env.REZ_SUPPORT_LINKEDIN;
 try{
  process.env.REZ_SUPPORT_EMAIL='owner@metu.edu.tr';process.env.REZ_SUPPORT_LINKEDIN='https://www.linkedin.com/in/example-person';
  for(const lang of ['tr','en']){
   f.store.setLanguage(123,lang);
   for(const r of [handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/support'}),handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data:'c'})]){
    assert.match(r.text,/owner@metu\.edu\.tr/);assert.ok(buttons(r).some(b=>b.url===process.env.REZ_SUPPORT_LINKEDIN));assert.ok(buttons(r).some(b=>b.callback_data==='h'));
    assert.doesNotMatch(r.text,/saklan|kept only|\/sil|\/delete|retention/i);
   }
  }
 }finally{if(oldEmail===undefined)delete process.env.REZ_SUPPORT_EMAIL;else process.env.REZ_SUPPORT_EMAIL=oldEmail;if(oldLinkedIn===undefined)delete process.env.REZ_SUPPORT_LINKEDIN;else process.env.REZ_SUPPORT_LINKEDIN=oldLinkedIn;f.close();}
});
test('my selections never include technical health rows or a Status action',t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date(now)});
 const f=fixture(),date=day;try{
  f.store.subscribe(123,'17',{date,startAfter:'15:30',notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions);f.store.state.readerPlan={facilityIds:['17'],dates:[date]};
  for(const lang of ['tr','en']){
   f.store.setLanguage(123,lang);let expected;
   for(const phase of ['ready','waiting_verification','network_wait','reconnecting']){
    f.store.state.readerState={phase};f.store.state.readerFacilityStates={'17':{phase}};
    const r=handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/selections'});
    assert.match(r.text,/Baraka Fitness/);assert.match(r.text,/16:00/);assert.match(r.text,/18:00/);assert.doesNotMatch(r.text,/15:30/);assert.ok(buttons(r).some(b=>/^(?:px|pr):/.test(b.callback_data||'')));assert.ok(buttons(r).some(b=>b.callback_data==='u'));
    assert.equal(buttons(r).some(b=>b.callback_data==='s'||/Durum|Status/i.test(b.text)),false);
    assert.doesNotMatch(r.text,/takvim kontrol|bağlantı|kontrol sürüyor|takip durumu|coverage|reconnect|calendar check|Checking/i);
    if(expected)assert.equal(r.text,expected,'technical phases do not change the selections text');else expected=r.text;
   }
  }
  assert.equal(JSON.stringify(f.store.state.subscriptions),before);
 }finally{f.close();}
});
test('retired status callbacks and commands return selections without exposing diagnostics',()=>{
 const f=fixture(),date=pickerDates()[0];try{
  f.store.subscribe(123,'17',{date,startAfter:'15:30',notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions);f.store.state.readerState={phase:'waiting_verification'};
  for(const lang of ['tr','en']){
   f.store.setLanguage(123,lang);const expected=handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/selections'});
   const replies=['/status','/durum'].map(text=>handleBotCommand(f.store,{chat:{id:123,type:'private'},text}));replies.push(handleBotCallback(f.store,{id:'old',from:{id:123},message:{chat:{id:123,type:'private'},message_id:7},data:'s'}));
   for(const r of replies){assert.equal(r.text,expected.text);assert.deepEqual(r.replyMarkup,expected.replyMarkup);}
   assert.equal(botCommands(lang).some(c=>['status','durum'].includes(c.command)),false);
  }
  assert.equal(JSON.stringify(f.store.state.subscriptions),before);
 }finally{f.close();}
});
test('retired completion buttons do not reveal technical tracking information',()=>{
 const f=fixture(),date=pickerDates()[0];try{
  f.store.subscribe(123,'17',{date,notifyAvailable:true});f.store.state.readerState={phase:'waiting_verification'};
  for(const lang of ['tr','en']){
   f.store.setLanguage(123,lang);const r=handleBotCallback(f.store,{id:'old',from:{id:123},message:{chat:{id:123,type:'private'},message_id:7},data:`done:17:${date.replaceAll('-','')}`});
   assert.match(r.text,/Baraka Fitness/);assert.doesNotMatch(r.text,/kontrol|takvim|bağlantı|Takip duraklat|verification|calendar|check|paused|not being monitored/i);
  }
 }finally{f.close();}
});
test('a full session stays selectable: earlier and last week times are shown next to current places',()=>{
 const f=fixture();try{
  const page=f.store.engine.pages[`17|${day}`];page.slots[`${day}|08:00|09:30`]={free:1};
  f.store.engine.pages['17|2026-10-22']={facility:{id:'17'},date:'2026-10-22',slots:{'2026-10-22|10:00|11:30':{free:3}},observedSlotKeys:[]};
  const options=sessionOptions(f.store,'17',day,now);
  assert.deepEqual(options.map(o=>`${o.start}:${o.source}`),['08:00:seen','10:00:usual','16:00:current','18:00:current']);
  const menu=sessionMenu(f.store,123,'17',day,now);
  assert.ok(buttons(menu).some(b=>b.text==='▫️ 08:00–09:30 · ⚪ şu an boş yer yok'));
  assert.ok(buttons(menu).some(b=>b.text==='▫️ 10:00–11:30 · ⚪ şu an boş yer yok'));
  assert.doesNotMatch(JSON.stringify(menu),/önceki hafta|🕘/);
  assert.match(menu.text,/Site dolu seansları göstermez/);
  handlePickerCallback(f.store,123,`q:17:${code}:10001130:1`,now);
  assert.deepEqual(f.store.filtersFor(123,'17').map(x=>[x.startAfter,x.endBefore,x.exactTime]),[['10:00','11:30',true]]);
 }finally{f.close();}
});
test('a long list replaced by a short menu is sent at the bottom and the old list is removed',async()=>{
 const f=fixture();try{
  const rows=Array.from({length:30},(_,i)=>[{text:`T${i}`,callback_data:'t:17'}]);
  const reply=handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:9,reply_markup:{inline_keyboard:rows}},data:'t:17'});
  assert.equal(reply.replaceMessage,true);
  const short=handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:9,reply_markup:{inline_keyboard:rows.slice(0,6)}},data:'t:17'});
  assert.equal(short.replaceMessage,undefined);
  const {createMenuDispatcher}=await import('../src/telegram.mjs');const calls=[];
  const d=createMenuDispatcher(f.store,{sendMessage:async(chat,text)=>{calls.push(['send',text.slice(0,10)]);return {message_id:10};},deleteMessage:async(chat,id)=>{calls.push(['delete',id]);},editMessageText:async()=>calls.push(['edit'])});
  d.enqueue(reply);await d.drain();
  assert.deepEqual(calls.map(c=>c[0]),['send','delete']);assert.equal(calls[1][1],9);
  calls.length=0;const old=createMenuDispatcher(f.store,{sendMessage:async()=>({message_id:11}),deleteMessage:async()=>{throw Object.assign(new Error('too old'),{status:400});},editMessageText:async(chat,id,text)=>calls.push([id,text])});
  old.enqueue({...reply});await old.drain();assert.deepEqual(calls,[[9,'⬇️ Menü aşağıda.']]);
 }finally{f.close();}
});
test('Done is absent while legacy completion callbacks remain safe',t=>{
 t.mock.timers.enable({apis:['Date'],now:now+86400000});
 const f=fixture();try{
  f.store.subscribe(123,'17',{date:day,startAfter:'08:00',endBefore:'09:30',exactTime:true,notifyAvailable:true});
  const before=JSON.stringify(f.store.state.subscriptions);
  const menu=sessionMenu(f.store,123,'17',day,now);assert.equal(buttons(menu).some(b=>b.text==='✅ Bitti'),false);
  const done=handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data:`done:17:${code}`});
  assert.match(done.text,/Seçimlerin kaydedildi/);assert.doesNotMatch(done.text,/Takip ediliyor|Takip duraklatıldı|kontrol sürüyor/);assert.match(done.text,/08:00–09:30/);assert.equal(JSON.stringify(f.store.state.subscriptions),before);
  t.mock.timers.setTime(now+5*86400000);
  const expired=handleBotCallback(f.store,{id:'expired',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data:`done:17:${code}`});
  assert.match(expired.text,/Seçimlerim/);assert.doesNotMatch(expired.text,/Seçimlerin kaydedildi/);assert.equal(JSON.stringify(f.store.state.subscriptions),before);
 }finally{f.close();}
});

test('a later fresh calendar can add changed session times beyond an older official definition without inventing availability',()=>{const f=fixture();try{f.store.setSessionCatalog('17',day,[{start:'08:00',end:'09:30'}],new Date(now-60000).toISOString());const opts=sessionOptions(f.store,'17',day,now);assert.ok(opts.some(x=>x.start==='16:00'&&x.free===2));assert.ok(opts.some(x=>x.start==='08:00'&&x.free===null));assert.equal(f.store.filtersFor(123,'17').length,0);}finally{f.close();}});
test('each saved selection has its own delete button naming place, day and time; one tap removes only that one',t=>{
 // Keep the whole-day selection on an unknown weekday, independent of the real calendar.
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-02T10:00:00Z')});
 const f=fixture();try{
  const iso=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
  f.store.subscribe(123,'17',{date:iso(1),startAfter:'16:00',endBefore:'17:40',exactTime:true,notifyAvailable:true});
  f.store.subscribe(123,'17',{date:iso(1),startAfter:'18:00',endBefore:'19:45',exactTime:true,notifyAvailable:true});
  f.store.subscribe(123,'21',{date:iso(2),notifyAvailable:true});
  f.store.subscribe(456,'17',{date:iso(1),startAfter:'16:00',endBefore:'17:40',exactTime:true,notifyAvailable:true});
  const cb=(data,chat=123)=>handleBotCallback(f.store,{id:'cb',from:{id:chat},message:{chat:{id:chat,type:'private'},message_id:1},data});
  const deletes=buttons(cb('p')).filter(b=>b.callback_data?.startsWith('px:'));
  assert.equal(deletes.length,3);
  const target=deletes.find(b=>b.text.includes('18:00–19:45'));
  assert.match(target.text,/^🗑 \d+ \S+ \S+ · 18:00–19:45$/);assert.ok(deletes.every(b=>b.text.length<=32),'fits on a phone');
  assert.ok(deletes.some(b=>/^🗑 .+ · Tüm seanslar$/.test(b.text)));
  const after=cb(target.callback_data);
  assert.match(after.text,/✅ Silindi: Baraka Fitness · .+ · 18:00–19:45/);
  assert.deepEqual(f.store.filtersFor(123,'17').map(x=>x.startAfter),['16:00']);
  assert.equal(f.store.filtersFor(123,'21').length,1);assert.equal(f.store.filtersFor(456,'17').length,1,'other chats are untouched');
  assert.doesNotMatch(cb(target.callback_data).text,/Silindi/,'a repeated tap on a removed selection changes nothing');
  assert.doesNotMatch(cb(target.callback_data,456).text,/Silindi: Baraka Fitness · .+ · 18:00/);
 }finally{f.close();}
});
test('missing hours are estimated from the most similar day; overlapping times and unknown days get none',()=>{
 const f=fixture();try{
  const mk=(date,times)=>({facility:{id:'17'},date,lastSuccessAt:new Date(now).toISOString(),baselineConfirmed:true,observedSlotKeys:[],
   slots:Object.fromEntries(times.map(([s,e])=>[`${date}|${s}|${e}`,{free:1}]))});
  const weekday=[['08:00','09:30'],['10:00','11:30'],['12:00','13:30'],['14:00','15:40'],['16:00','17:40'],['18:00','19:40'],['20:00','21:40']];
  f.store.engine.pages['17|2026-10-26']=mk('2026-10-26',weekday);
  f.store.engine.pages['17|2026-10-25']=mk('2026-10-25',[['09:00','10:45'],['11:00','12:45'],['13:00','14:45']]);
  f.store.engine.pages['17|2026-10-31']=mk('2026-10-31',[['16:00','17:40'],['18:00','19:40'],['20:00','21:40']]);
  const sat=sessionOptions(f.store,'17','2026-10-31',now);
  assert.deepEqual(sat.filter(o=>o.source==='inferred').map(o=>o.start),['08:00','10:00','12:00','14:00']);
  assert.equal(sat.some(o=>o.start==='09:00'||o.start==='11:00'),false,'a different day pattern is not mixed in');
  const menu=sessionMenu(f.store,123,'17','2026-10-31',now);
  assert.match(menu.text,/Bazı saatler diğer günlerden tahmin edildi/);
  assert.ok(buttons(menu).some(b=>b.text==='▫️ 08:00–09:30 · ⚪ şu an boş yer yok'));
  f.store.engine.pages['17|2026-10-29']=mk('2026-10-29',[]);
  assert.deepEqual(sessionOptions(f.store,'17','2026-10-29',now).filter(o=>o.source==='inferred'),[],'a day with no known session is not invented');
 }finally{f.close();}
});
test('a chosen session matches the real one by start time even if its end was estimated slightly differently',()=>{
 const sub={facilityId:'17',date:'2026-10-31',startAfter:'10:00',endBefore:'11:30',exactTime:true,notifyAvailable:true,active:true};
 const ev=(start,end)=>({facility:{id:'17'},date:'2026-10-31',start,end});
 assert.equal(subscriptionMatches(sub,ev('10:00','11:30')),true);
 assert.equal(subscriptionMatches(sub,ev('10:00','11:40')),true);
 assert.equal(subscriptionMatches(sub,ev('10:00','12:15')),false);
 assert.equal(subscriptionMatches(sub,ev('10:30','11:30')),false);
});
test('a learned weekly list is the day’s session menu: full ones stay selectable and nothing is estimated',()=>{
 const f=fixture();try{
  f.store.state.sessionCatalog={[`17|${day}`]:{source:'weekly-publication',verifiedAt:new Date(now-3600000).toISOString(),
   sessions:[{start:'08:00',end:'09:40'},{start:'10:00',end:'11:40'},{start:'16:00',end:'17:40'},{start:'18:00',end:'19:45'}]}};
  const options=sessionOptions(f.store,'17',day,now);
  assert.deepEqual(options.map(o=>`${o.start}:${o.source}`),['08:00:seen','10:00:seen','16:00:current','18:00:current']);
  const menu=sessionMenu(f.store,123,'17',day,now);
  assert.ok(buttons(menu).some(b=>b.text==='▫️ 08:00–09:40 · ⚪ şu an boş yer yok'));
  assert.doesNotMatch(menu.text,/tahmin/);
 }finally{f.close();}
});
test('a "15:30 sonrası" choice is shown as its real sessions; removing one keeps the others as separate choices',()=>{
 const f=fixture();try{
  const tomorrow=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(Date.now()+86400000));
  const page=f.store.engine.pages[`17|${day}`];
  f.store.engine.pages[`17|${tomorrow}`]={...page,date:tomorrow,lastSuccessAt:new Date().toISOString(),slots:Object.fromEntries(Object.entries(page.slots).map(([k,v])=>[k.replace(day,tomorrow),v])),observedSlotKeys:page.observedSlotKeys.map(k=>k.replace(day,tomorrow))};
  f.store.subscribe(123,'17',{date:tomorrow,startAfter:'15:30',notifyAvailable:true});
  const cb=data=>handleBotCallback(f.store,{id:'cb',from:{id:123},message:{chat:{id:123,type:'private'},message_id:1},data});
  const menu=cb('p');
  assert.doesNotMatch(menu.text,/15:30 sonrası/);assert.match(menu.text,/16:00–17:40, 18:00–19:45/);
  const deletes=buttons(menu).filter(b=>b.callback_data?.startsWith('pr:'));
  assert.deepEqual(deletes.map(b=>b.text.split(' · ').at(-1)),['16:00–17:40','18:00–19:45']);
  const after=cb(deletes[0].callback_data);
  assert.match(after.text,/✅ Silindi: Baraka Fitness · .+ · 16:00–17:40/);
  assert.deepEqual(f.store.filtersFor(123,'17').map(x=>[x.startAfter,x.endBefore,x.exactTime===true]),[['18:00','19:45',true]]);
  assert.equal(cb(deletes[0].callback_data).text.includes('Silindi'),false,'an old button cannot remove anything else');
  f.store.subscribe(123,'21',{date:tomorrow,startAfter:'22:30',notifyAvailable:true});
  const unknown=cb('p');assert.match(unknown.text,/22:30 sonrası/);assert.ok(buttons(unknown).some(b=>b.callback_data?.startsWith('px:')&&/22:30 sonrası/.test(b.text)));
 }finally{f.close();}
});

function multiFixture(unknown=false){
 const f=fixture();f.store.setFacilityCatalog([
  {id:'1',label:'1 Nolu Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'},
  {id:'2',label:'2 Nolu Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'},
  {id:'3',label:'3 Nolu Tenis Kortu (Büyük Spor Salonu)',unit:'Spor Müdürlüğü'},
  {id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'},
  {id:'31',label:'Havuz',unit:'Havuz Müdürlüğü'}]);
 f.store.state.readerPlan={facilityIds:['1','2','3','17','31'],dates:pickerDates(now)};
 for(const id of ['1','2',...(unknown?[]:['3'])])for(const date of [day,'2026-10-30'])f.store.setSessionCatalog(id,date,[{start:'10:00',end:'11:00'},{start:'17:00',end:'18:00'}],new Date(now).toISOString());
 return f;
}
function ma(f,action,chatId=123,at=now){
 const d=f.store.state.selectionDrafts?.[String(chatId)];return handleMultiPickerCallback(f.store,chatId,action==='start'?'m:start':`m:${d.id}:${action}`,at);
}
function multiChoose(f,ids=['1','2','3'],dates=[day,'2026-10-30'],times=['10001100','17001800']){
 ma(f,'start');let d=f.store.state.selectionDrafts['123'];
 for(const id of ids){ma(f,`unit:${d.units.indexOf(f.store.catalogFacility(id).unit)}`);ma(f,`f:${d.facilityChoices.indexOf(id)}`);}
 ma(f,'next');for(const date of dates)ma(f,`d:${date.replaceAll('-','')}`);
 ma(f,'next');for(const time of times)ma(f,`t:${time}`);
}

test('quick selection saves 3 courts × 2 days × 2 exact times without replacing existing preferences',()=>{
 const f=multiFixture();try{
  f.store.subscribe(123,'17',{date:day,startAfter:'15:30',notifyAvailable:true});
  f.store.subscribe(456,'1',{date:day,notifyAvailable:true});
  const prior=f.store.filtersFor(123,'17')[0];prior.availabilityChecks={kept:{deliveredId:'prior'}};
  multiChoose(f);const result=ma(f,'save');
  assert.match(result.text,/3 tesis · 2 gün · 2 saat/);
  const saved=f.store.subscriptionsFor(123).filter(s=>['1','2','3'].includes(s.facilityId));
  assert.equal(saved.length,12);assert.ok(saved.every(s=>s.exactTime&&s.notifyAvailable));
  assert.equal(f.store.filtersFor(123,'17')[0],prior);assert.equal(prior.availabilityChecks.kept.deliveredId,'prior');
  assert.equal(f.store.filtersFor(456,'1').length,1);
  ma(f,'save');assert.equal(f.store.subscriptionsFor(123).length,13);
  multiChoose(f);ma(f,'save');assert.equal(f.store.subscriptionsFor(123).length,13,'a new draft does not duplicate saved times');
 }finally{f.close();}
});
test('an unknown court/day gets whole-day watches, and all-times applies to every facility/day',()=>{
 const f=multiFixture(true);try{
  multiChoose(f);ma(f,'save');assert.equal(f.store.subscriptionsFor(123).length,10);
  assert.equal(f.store.filtersFor(123,'3').length,2);assert.ok(f.store.filtersFor(123,'3').every(s=>!s.exactTime&&!s.startAfter&&s.notifyAvailable));
  multiChoose(f,['17','31'],[day,'2026-10-30'],[]);ma(f,'all');ma(f,'save');
  assert.equal(f.store.filtersFor(123,'31').length,2);assert.ok(f.store.filtersFor(123,'17').every(s=>!s.startAfter));
 }finally{f.close();}
});
test('quick selection drafts and callback nonces are isolated by chat; stale and forged hours do not create filters',()=>{
 const f=multiFixture();try{
  multiChoose(f,['1'],[day],[]);const d=f.store.state.selectionDrafts['123'];
  ma(f,'start',456);const before=JSON.stringify(f.store.state.selectionDrafts);
  handleMultiPickerCallback(f.store,456,`m:${d.id}:save`,now);
  assert.equal(JSON.stringify(f.store.state.selectionDrafts),before);assert.equal(f.store.subscriptionsFor(456).length,0);
  ma(f,'t:06001300');assert.deepEqual(d.times,[]);ma(f,'save');assert.equal(f.store.subscriptionsFor(123).length,0);
  const fake=handleBotCallback(f.store,{id:'cb',from:{id:456},message:{chat:{id:123,type:'private'},message_id:1},data:`m:${d.id}:t:10001100`});assert.equal(fake,null);
  ma(f,'t:10001100');delete f.store.state.sessionCatalog[`1|${day}`];
  ma(f,'save');assert.equal(f.store.subscriptionsFor(123).length,0,'an obsolete time requires re-selection');
 }finally{f.close();}
});
test('48-per-facility cap is checked before any multi-picker additions; existing other days are not lost',()=>{
 const f=multiFixture();try{
  for(let i=0;i<48;i++)f.store.subscribe(123,'3',{date:'2026-11-01',startAfter:`00:${String(i).padStart(2,'0')}`,endBefore:`00:${String(i+1).padStart(2,'0')}`,notifyAvailable:true,exactTime:true});
  multiChoose(f,['1','3'],[day],['10001100']);const before=JSON.stringify(f.store.state.subscriptions),result=ma(f,'save');
  assert.match(result.answerText,/48/);assert.equal(JSON.stringify(f.store.state.subscriptions),before);assert.equal(f.store.filtersFor(123,'1').length,0);
 }finally{f.close();}
});
test('30-minute draft expiry, whole-week and evening shortcuts, and disabled Continue are predictable',()=>{
 const f=multiFixture();try{
  const empty=ma(f,'start');const next=buttons(empty).find(b=>/Devam/.test(b.text));assert.ok(next.callback_data.endsWith(':noop'));assert.equal(next.style,undefined);
  ma(f,'next');assert.equal(f.store.state.selectionDrafts['123'].stage,'f');
  ma(f,'group:tennis');assert.equal(f.store.state.selectionDrafts['123'].facilities.length,3);
  ma(f,'next');ma(f,'week');assert.deepEqual(f.store.state.selectionDrafts['123'].dates,pickerDates(now));ma(f,'next');ma(f,'evening');assert.deepEqual(f.store.state.selectionDrafts['123'].times,['17001800']);
  const d=f.store.state.selectionDrafts['123'];const expired=handleMultiPickerCallback(f.store,123,`m:${d.id}:save`,now+30*60000);assert.match(expired.text,/süresi doldu/);assert.equal(f.store.state.selectionDrafts['123'],undefined);
 }finally{f.close();}
});
test('callbacks fit 64 bytes, lists paginate, languages are isolated and drafts are deleted with the account',()=>{
 const f=multiFixture();try{
  const facilities=Array.from({length:28},(_,i)=>({id:String(i+1),label:`${i+1} Nolu Tenis Kortu (Büyük Spor Salonu)`,unit:'Spor Müdürlüğü'}));f.store.setFacilityCatalog(facilities);
  f.store.setLanguage(456,'en');const tr=ma(f,'start'),en=ma(f,'start',456);assert.match(tr.text,/Hızlı seçim/);assert.match(en.text,/Quick selection/);
  const page=ma(f,'page:1');assert.ok(buttons(page).some(b=>b.text==='2/3'));
  for(const menu of [tr,en,page])for(const b of buttons(menu)){assert.ok(Buffer.byteLength(b.callback_data)<=64);assert.ok(Array.from(b.text).length<=45);}
  f.store.forgetChat(123);assert.equal(f.store.state.selectionDrafts['123'],undefined);assert.ok(f.store.state.selectionDrafts['456']);
 }finally{f.close();}
});
test('unknown single-day tap saves all sessions immediately; a second tap asks before removal',()=>{
 const f=fixture();try{
  const date='2026-10-30',data=`d:5:${date.replaceAll('-','')}`;
  const first=handlePickerCallback(f.store,123,data,now);assert.match(first.text,/eklendi · bütün seanslar/);assert.equal(first.answerText,'✅ Kaydedildi');assert.equal(f.store.filtersFor(123,'5').length,1);assert.equal(buttons(first).some(b=>b.callback_data.startsWith('q:')),false);
  const confirm=handlePickerCallback(f.store,123,data,now);assert.match(confirm.text,/kaldırılsın mı/);assert.equal(f.store.filtersFor(123,'5').length,1);
  const remove=buttons(confirm).find(b=>b.callback_data.startsWith('dx:'));const done=handlePickerCallback(f.store,123,remove.callback_data,now);assert.equal(f.store.filtersFor(123,'5').length,0);assert.equal(done.answerText,'🗑 Kaldırıldı');
 }finally{f.close();}
});
test('single-session toggles give saved/removed feedback and make the whole-day off action explicit',()=>{
 const f=fixture();try{
  const added=handlePickerCallback(f.store,123,`q:17:${code}:16001740:1`,now);assert.equal(added.answerText,'✅ Kaydedildi');assert.equal(buttons(added).some(b=>/Bitti|Done/.test(b.text)),false);
  const removed=handlePickerCallback(f.store,123,`q:17:${code}:16001740:0`,now);assert.equal(removed.answerText,'🗑 Kaldırıldı');
  const all=handlePickerCallback(f.store,123,`da:17:${code}:1`,now);assert.ok(buttons(all).some(b=>/Bütün gün izleniyor · kapatmak için dokun/.test(b.text)));
 }finally{f.close();}
});
test('the real Telegram loop answers a selection callback once with the saved feedback', {timeout:2000},async()=>{
 const f=fixture(),controller=new AbortController(),answers=[];let polls=0;
 const date=pickerDates().at(-1).replaceAll('-','');
 const api={getUpdates:async()=>++polls===1?[{update_id:1,callback_query:{id:'selection-toast',from:{id:123},message:{message_id:9,chat:{id:123,type:'private'}},data:`d:5:${date}`}},{update_id:2,callback_query:{id:'pool-soon',from:{id:123},message:{message_id:9,chat:{id:123,type:'private'}},data:'soon:pool'}}]:(controller.abort(),[]),answerCallbackQuery:async(id,text)=>answers.push({id,text}),editMessageText:async()=>{}};
 try{await runTelegramLoop(f.store,api,controller.signal);assert.deepEqual(answers,[{id:'selection-toast',text:'✅ Kaydedildi'},{id:'pool-soon',text:'🏊 Tadilat tamamlanınca burada olacak.'}]);}finally{controller.abort();f.close();}
});

test('known times are unioned and sorted; a time is only added where that exact session exists',()=>{
 const f=multiFixture();try{
  f.store.setSessionCatalog('2',day,[{start:'11:00',end:'12:00'}],new Date(now).toISOString());
  multiChoose(f,['1','2'],[day],['10001100']);
  const menu=ma(f,'noop'),times=buttons(menu).filter(b=>/\bt:\d{8}$/.test(b.callback_data)).map(b=>b.callback_data.split(':').at(-1));
  assert.deepEqual(times,['10001100','11001200','17001800']);
  ma(f,'save');assert.equal(f.store.filtersFor(123,'1').length,1);assert.equal(f.store.filtersFor(123,'2').length,0);
  f.store.setLanguage(123,'en');const summary=ma(f,'save');assert.ok(summary.text.split('\n').every(line=>Array.from(line).length<=45));
 }finally{f.close();}
});

test('simple session screen omits refresh, stop-day and Done, but day navigation keeps saved selections',()=>{
 const f=fixture();try{
  handlePickerCallback(f.store,123,`q:17:${code}:16001740:1`,now);
  const menu=sessionMenu(f.store,123,'17',day,now),list=buttons(menu);
  assert.equal(list.some(b=>b.callback_data.startsWith('d:')||b.callback_data.startsWith('dx:')||b.callback_data.startsWith('done:')),false);
  assert.ok(list.some(b=>b.callback_data==='t:17'));assert.ok(list.some(b=>b.callback_data==='p'));
  handlePickerCallback(f.store,123,'t:17',now);handlePickerCallback(f.store,123,'d:17:20261030',now);
  assert.ok(f.store.filtersFor(123,'17').some(s=>s.date===day&&s.startAfter==='16:00'));
 }finally{f.close();}
});

test('a time learned after publication remains selectable when it later fills, without stale free counts',()=>{
 const f=fixture();try{
  (f.store.state.sessionCatalog||={})[`17|${day}`]={source:'weekly-publication',verifiedAt:new Date(now-60000).toISOString(),sessions:[{start:'08:00',end:'09:30'}]};
  f.store.learnCalendarChanges({state:'ok',fresh:true,facility:{id:'17'},date:day,observedAt:new Date(now).toISOString(),slots:[{date:day,start:'16:00',end:'17:40',free:2}]});
  f.store.engine.pages[`17|${day}`].observedSlotKeys=[];
  const options=sessionOptions(f.store,'17',day,now+16*60000);assert.ok(options.some(s=>s.start==='16:00'&&s.free===null&&s.source==='seen'));
  f.store.setSessionCatalog('17',day,[{start:'18:30',end:'20:00'}],new Date(now+17*60000).toISOString());
  assert.deepEqual(sessionOptions(f.store,'17',day,now+18*60000).map(s=>s.start),['18:30']);
 }finally{f.close();}
});
