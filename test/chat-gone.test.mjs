import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {TelegramApi,flushOutbox} from '../src/telegram.mjs';
import {flushSlotUpdates} from '../src/slot-alerts.mjs';

const reply=(status,description)=>async()=>({ok:false,status,json:async()=>({ok:false,description})});
test('Telegram errors say when a chat can never be reached again',async()=>{
 const token='123456:'+'A'.repeat(30),gone=async (status,description)=>{
  const api=new TelegramApi(token,reply(status,description),null);
  return api.sendMessage(1,'x').then(()=>null,error=>error.chatGone);
 };
 assert.equal(await gone(403,'Forbidden: bot was blocked by the user'),true);
 assert.equal(await gone(403,'Forbidden: user is deactivated'),true);
 assert.equal(await gone(400,'Bad Request: chat not found'),true);
 assert.equal(await gone(400,'Bad Request: message is too long'),false);
 assert.equal(await gone(429,'Too Many Requests: retry after 5'),false);
});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'rez-gone-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new LocalStore(join(dir,'state.json'),{accessMode:'public'});store.state.fastAvailability=true;
 store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'}]);
 const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
 for(const chat of [601,602]){store.admitChat(chat);store.state.subscriptions.push({chatId:String(chat),facilityId:'17',date,startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true,active:true});}
 let n=0;const observe=free=>store.ingest({schema:1,source:'rez-calendar-extension',state:'ok',fresh:true,refresh_id:`gone-proof-${++n}`,observed_at:new Date().toISOString(),
  facility:{id:'17',label:'Fitness'},view:{type:'day',date},slots:free===null?[]:[{date,start:'16:00',end:'17:30',free}]});
 return {store,observe};
}
test('a chat that blocked the bot is forgotten after one failed alert; others keep their selections',async t=>{
 const f=fixture(t);f.observe(1);const sent=[];
 await flushOutbox(f.store,{sendMessage:async chat=>{if(String(chat)==='601')throw Object.assign(new Error('Forbidden'),{status:403,chatGone:true});sent.push(String(chat));return {message_id:1};}},{perSecond:100000});
 assert.deepEqual(sent,['602']);
 assert.equal(f.store.isChatAllowed(601),false);assert.equal(f.store.state.subscriptions.some(s=>s.chatId==='601'),false);
 assert.equal(f.store.isChatAllowed(602),true);assert.equal(f.store.state.subscriptions.some(s=>s.chatId==='602'),true);
});
test('a "Doldu" to a chat that blocked the bot meanwhile also forgets it',async t=>{
 const f=fixture(t);f.observe(1);await flushOutbox(f.store,{sendMessage:async()=>({message_id:7})},{perSecond:100000});
 f.observe(null);f.observe(null);
 await flushSlotUpdates(f.store,{sendMessage:async chat=>{if(String(chat)==='602')throw Object.assign(new Error('Forbidden'),{status:403,chatGone:true});return {message_id:8};}},{max:10});
 assert.equal(f.store.isChatAllowed(602),false);assert.equal(f.store.isChatAllowed(601),true);
 assert.equal(Object.keys(f.store.state.slotStatusJobs||{}).length,0);
 assert.equal(f.store.state.slotUpdateFailedAt,undefined);
});
