import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/store.mjs';
import { flushOutbox, createMenuDispatcher, createRateLimiter } from '../src/telegram.mjs';

// 1000 public chats all waiting for the same session, then one fresh reading.
function crowd(chats = 1000) {
  const folder = mkdtempSync(join(tmpdir(), 'rez-capacity-'));
  const store = new LocalStore(join(folder, 'state.json'), { accessMode: 'public', publicMaxChats: chats });
  store.state.fastAvailability = true;
  store.setFacilityCatalog([{ id: '17', label: 'Baraka Fitness', unit: 'Spor Müdürlüğü' }]);
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (let i = 1; i <= chats; i++) store.admitChat(1000 + i);
  for (let i = 1; i <= chats; i++) store.state.subscriptions.push({ chatId: String(1000 + i), facilityId: '17', active: true,
    date, startAfter: '16:00', endBefore: '17:30', exactTime: true, notifyAvailable: true });
  store.save();
  store.ingest({ schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true, refresh_id: 'capacity-proof-1',
    observed_at: new Date().toISOString(), facility: { id: '17', label: 'Baraka' }, view: { type: 'day', date },
    slots: [{ date, start: '16:00', end: '17:30', free: 2 }] });
  return { store, close: () => rmSync(folder, { recursive: true, force: true }) };
}

test('one vacancy watched by 1000 chats reaches every chat exactly once, with few state writes', async () => {
  const f = crowd();
  try {
    assert.equal(f.store.status().queued, 1000);
    const sent = [], inFlight = new Set();let overlap = false, saves = 0;
    const save = f.store.save.bind(f.store); f.store.save = () => { saves++; return save(); };
    const api = { sendMessage: async (chat) => {
      if (inFlight.has(chat)) overlap = true; inFlight.add(chat);
      await new Promise(r => setImmediate(r)); inFlight.delete(chat); sent.push(String(chat)); return { message_id: sent.length };
    } };
    for (let i = 0; i < 20 && f.store.status().queued; i++) await flushOutbox(f.store, api, { perSecond: 100000, concurrency: 25 });
    assert.equal(sent.length, 1000);
    assert.equal(new Set(sent).size, 1000);
    assert.equal(overlap, false);
    assert.equal(f.store.status().queued, 0);
    assert.equal(f.store.state.outbox.filter(item => item.status === 'sent').length, 1000);
    assert.ok(saves <= 40, `state written ${saves} times for 1000 alerts`);
  } finally { f.close(); }
});

test('a 429 in the middle of a round stops it: nothing is sent twice and nothing is left marked as sending', async () => {
  const f = crowd(100);
  try {
    let calls = 0;
    const api = { sendMessage: async () => { calls++; if (calls === 10) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 30000 }); return { message_id: calls }; } };
    await flushOutbox(f.store, api, { perSecond: 100000, concurrency: 1 });
    const statuses = f.store.state.outbox.reduce((n, item) => ({ ...n, [item.status]: (n[item.status] || 0) + 1 }), {});
    assert.equal(statuses.sent, 9);
    assert.equal(statuses.sending, undefined);
    assert.equal(statuses.queued, 91);
    assert.ok(f.store.state.deliveryBlockedUntil > Date.now());
    assert.equal(calls, 10);
  } finally { f.close(); }
});

test('300 chats tapping at once all get their menu; none is dropped and each chat keeps its order', async () => {
  const f = crowd(300);
  try {
    let active = 0, peak = 0;const seen = new Map();
    const api = { sendMessage: async (chat, text) => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 2)); active--;
      (seen.get(chat) || seen.set(chat, []).get(chat)).push(text); return { message_id: 1 }; } };
    const d = createMenuDispatcher(f.store, api);
    for (let i = 1; i <= 300; i++) { d.enqueue({ chatId: 1000 + i, text: 'first' }); d.enqueue({ chatId: 1000 + i, text: 'second' }); }
    await d.drain();
    assert.equal(seen.size, 300);
    assert.ok([...seen.values()].every(list => list.at(-1) === 'second'));
    assert.ok(peak <= 64, `peak ${peak}`);
  } finally { f.close(); }
});

test('the shared Telegram pace allows a short burst, then about 28 sends per second', async () => {
  let clock = 0;
  const limiter = createRateLimiter(28, () => clock, async ms => { clock += ms; });
  for (let i = 0; i < 100; i++) await limiter.take();
  assert.ok(clock >= 2500 && clock <= 2700, `100 sends took ${clock} simulated ms`);
});

test('the public bot accepts 5000 chats by default and queues a vacancy for each watcher once',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-cap5000-'));const store=new LocalStore(join(folder,'state.json'),{accessMode:'public'});
 try{
  assert.equal(store.publicMaxChats,5000);
  const f=crowd(3000);try{assert.equal(f.store.status().queued,3000);assert.equal(new Set(f.store.state.outbox.map(i=>i.chatId)).size,3000);}finally{f.close();}
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('legacy weekly jobs never send and old opt-in buttons cannot re-enable public notices in either language',async()=>{
 const {flushBroadcast,handleBotCallback}=await import('../src/telegram.mjs');
 const folder=mkdtempSync(join(tmpdir(),'rez-broadcast-'));const store=new LocalStore(join(folder,'state.json'),{accessMode:'public'});
 try{
  for(let i=1;i<=25;i++)store.admitChat(500+i);store.setLanguage(501,'en');
  store.state.broadcast={id:'week-2026-11-02',kind:'week',weekStart:'2026-11-02',weekEnd:'2026-11-08',createdAt:new Date().toISOString(),pending:Array.from({length:25},(_,i)=>String(501+i))};
  let calls=0;const api={sendMessage:async()=>{calls++;throw new Error('Public broadcast forbidden');}};
  store.state.deliveryBlockedUntil=Date.now()+60_000;
  assert.equal(await flushBroadcast(store,api,{max:10}),0);
  assert.equal(calls,0);assert.equal(store.state.broadcast,null,'old queue is dropped even during rate-limit backoff');
  for(const language of ['tr','en']){
   store.setLanguage(502,language);
   const callback=data=>handleBotCallback(store,{id:'cb',from:{id:502},message:{chat:{id:502,type:'private'},message_id:3},data});
   for(const result of [callback('settings'),callback('wn:0'),callback('wn:1')]){
    assert.doesNotMatch(result.text,/hafta|week|21[.:]00|22[.:]00/i);
    assert.equal(result.replyMarkup.inline_keyboard.flat().some(b=>/^wn:/.test(b.callback_data||'')),false);
   }
   assert.equal(store.weekNoticeOn(502),false);
  }
  assert.equal(calls,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('5000 registered chats all retain their menu while transport is blocked; guest hints cannot evict them',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-menu-5000-'));const store=new LocalStore(join(folder,'state.json'),{accessMode:'public'});
 try{
  store.state.betaApprovedChatIds=Array.from({length:5000},(_,i)=>String(1000000+i));let release;const barrier=new Promise(r=>release=r),seen=new Map();
  const d=createMenuDispatcher(store,{sendMessage:async(chat,text)=>{await barrier;seen.set(String(chat),text);return {message_id:1};}});
  for(let i=0;i<5000;i++)d.enqueue({chatId:1000000+i,text:'first'});
  for(let i=0;i<300;i++)d.enqueue({chatId:9000000+i,text:'guest'});
  d.enqueue({chatId:1004999,text:'latest'});release();await d.drain();
  for(let i=0;i<5000;i++)assert.ok(seen.has(String(1000000+i)),`missing registered menu ${i}`);
  assert.equal(seen.get('1004999'),'latest');
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('more than 1000 watchers keep every Full follow-up; batched status sends preserve order and save far fewer times',async()=>{
 const {flushSlotUpdates}=await import('../src/slot-alerts.mjs');
 const count=1100,folder=mkdtempSync(join(tmpdir(),'rez-followups-1100-')),store=new LocalStore(join(folder,'state.json'),{accessMode:'public'});
 try{
  store.state.fastAvailability=true;store.setFacilityCatalog([{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]);
  const date=new Date(Date.now()+86400000).toISOString().slice(0,10);store.state.betaApprovedChatIds=Array.from({length:count},(_,i)=>String(2000000+i));
  store.state.subscriptions=store.state.betaApprovedChatIds.map(chatId=>({chatId,facilityId:'17',date,startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true,active:true}));
  const observe=(free,id)=>store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:id,observed_at:new Date().toISOString(),facility:{id:'17',label:'Fitness'},view:{type:'day',date},slots:[{date,start:'16:00',end:'17:30',free}]});
  observe(1,'followup-cap-free');let msg=0;const available=new Set();
  while(store.status().queued)await flushOutbox(store,{sendMessage:async chat=>{available.add(chat);return{message_id:++msg};}},{perSecond:1000000,concurrency:25});
  assert.equal(available.size,count);assert.equal(Object.keys(store.state.slotAlerts).length,count);
  observe(0,'followup-cap-full');assert.equal(Object.values(store.state.slotStatusJobs).filter(j=>j.notify&&j.status==='full').length,count);
  const sent=[],active=new Set();let overlap=false,saves=0;const save=store.save.bind(store);store.save=()=>{saves++;save();};
  await flushSlotUpdates(store,{sendMessage:async(chat,text,_markup,_timeout,replyTo)=>{if(active.has(chat))overlap=true;active.add(chat);await new Promise(r=>setImmediate(r));active.delete(chat);sent.push({chat,text,replyTo});return{message_id:++msg};}},{max:count});
  assert.equal(sent.length,count);assert.equal(new Set(sent.map(s=>s.chat)).size,count);assert.ok(sent.every(s=>s.text.startsWith('🔴 Doldu')&&s.replyTo>0));assert.equal(overlap,false);assert.ok(saves<120,`status writes ${saves}`);
  assert.equal(Object.keys(store.state.slotStatusJobs).length,0);assert.ok(Object.values(store.state.slotAlerts).every(a=>a.lastNotified==='full'));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
