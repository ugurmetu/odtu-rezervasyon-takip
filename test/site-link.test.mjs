import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {LocalStore} from '../src/store.mjs';import {withFixedSiteShortcut,siteShortcutText,siteReplyKeyboard} from '../src/site-link.mjs';
import {TelegramApi,handleBotCommand,createMenuDispatcher} from '../src/telegram.mjs';
const url='https://rez.metu.edu.tr/',hasSite=m=>m?.inline_keyboard?.flat().some(b=>b.url===url);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rez-fixed-link-')),store=new LocalStore(path.join(dir,'state.json'),{accessMode:'public'});store.admitChat(123);store.admitChat(456);
 const messages=new Map(),edits=[],keyboards=new Map();let seq=0;
 const raw={sendMessage:async(chat,text,markup,...rest)=>{const message_id=++seq;messages.set(`${chat}:${message_id}`,{chat,text,markup,rest});if(markup?.keyboard)keyboards.set(String(chat),markup);if(markup?.remove_keyboard)keyboards.delete(String(chat));return {message_id};},
 editMessageReplyMarkup:async(chat,id,markup)=>{edits.push({chat,id,markup});const m=messages.get(`${chat}:${id}`);if(m)m.markup=markup;return true;},
 editMessageText:async(chat,id,text,markup)=>{const m=messages.get(`${chat}:${id}`);if(m)Object.assign(m,{text,markup});return {message_id:id};},deleteMessage:async(chat,id)=>{messages.delete(`${chat}:${id}`);return true;}};
 const api=withFixedSiteShortcut(store,raw);t.after(async()=>{await api.stopSiteLinks();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store,raw,api,messages,edits,keyboards};
}
test('a vacancy installs a single persistent bottom shortcut; later alerts have no inline site buttons',async t=>{
 const f=fixture(t);await f.api.sendMessage(123,'Place opened',{inline_keyboard:[[{text:'Old site',url}]]});await f.api.sendMessage(123,'Full');
 const k=f.keyboards.get('123');assert.equal(k.is_persistent,true);assert.equal(k.one_time_keyboard,false);assert.equal(k.resize_keyboard,true);assert.deepEqual(k.keyboard,[[{text:'🌐 Rezervasyon sitesi',style:'primary'}]]);
 assert.ok([...f.messages.values()].every(m=>!hasSite(m.markup)));assert.equal(f.messages.size,2);
});
test('the fixed label and /site return one ordinary HTTPS link, without a Web App or another inline site button',async t=>{
 const f=fixture(t);
 for(const text of [siteShortcutText('tr'),siteShortcutText('en'),'/site','/rez']){
  const r=handleBotCommand(f.store,{chat:{id:123,type:'private'},text});assert.ok(r.text.endsWith(url));assert.equal(r.text.split(url).length,2);assert.equal(r.replyMarkup,undefined);
  await f.api.sendMessage(r.chatId,r.text,r.replyMarkup);
 }
 for(const m of f.messages.values()){assert.equal(hasSite(m.markup),undefined);assert.doesNotMatch(JSON.stringify(m.markup),/web_app|request_contact|request_location/);}
});
test('inline navigation preserves its callbacks and the already installed bottom keyboard',async t=>{
 const f=fixture(t);await f.api.sendMessage(123,'Alert');const menu={inline_keyboard:[[{text:'Selections',callback_data:'p'}],[{text:'Old site',url}]]};
 const r=await f.api.sendMessage(123,'Menu',menu);await f.api.editMessageText(123,r.message_id,'Edited menu',menu);
 assert.deepEqual(f.messages.get(`123:${r.message_id}`).markup.inline_keyboard,[[{text:'Selections',callback_data:'p'}]]);assert.equal(f.keyboards.get('123').keyboard[0][0].text,siteShortcutText('tr'));
});
test('new menu users receive only their requested menu; no keyboard introduction is sent',async t=>{
 const f=fixture(t),d=createMenuDispatcher(f.store,f.api);
 for(let i=0;i<3;i++){d.enqueue(handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/menu'}));await d.drain();}
 assert.equal(f.messages.size,3);assert.ok([...f.messages.values()].every(m=>m.markup.inline_keyboard.flat().some(b=>b.callback_data==='u')));
 assert.equal(f.keyboards.has('123'),false);assert.equal(f.api.ensureSiteKeyboard,undefined);
});
test('the real menu dispatcher keeps an existing fixed keyboard without sending an extra message',async t=>{
 const f=fixture(t);await f.api.sendMessage(123,'Actual place opened');
 const d=createMenuDispatcher(f.store,f.api);d.enqueue(handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/menu'}));await d.drain();
 assert.equal(f.messages.size,2);assert.ok([...f.messages.values()][1].markup.inline_keyboard.flat().some(b=>b.callback_data==='u'));assert.ok(f.keyboards.has('123'));
});
test('the first inline menu does not silently create a second transport message',async t=>{
 const f=fixture(t),d=createMenuDispatcher(f.store,f.api);d.enqueue(handleBotCommand(f.store,{chat:{id:123,type:'private'},text:'/menu'}));await d.drain();
 assert.equal(f.messages.size,1);assert.ok([...f.messages.values()][0].markup.inline_keyboard.flat().some(b=>b.callback_data==='u'));
});
test('shortcut language is chat-specific; either previous language label still works after switching',async t=>{
 const f=fixture(t);f.store.setLanguage(456,'en');await f.api.sendMessage(123,'TR');await f.api.sendMessage(456,'EN');
 assert.equal(f.keyboards.get('123').keyboard[0][0].text,siteShortcutText('tr'));assert.equal(f.keyboards.get('456').keyboard[0][0].text,siteShortcutText('en'));
 f.store.setLanguage(123,'en');assert.equal(f.messages.size,2);const r=handleBotCommand(f.store,{chat:{id:123,type:'private'},text:siteShortcutText('tr')});assert.match(r.text,/Book \/ cancel/);
 await f.api.sendMessage(r.chatId,r.text,r.replyMarkup);assert.equal(f.messages.size,3);assert.equal(f.keyboards.get('123').keyboard[0][0].text,siteShortcutText('en'));
});
test('an ambiguous real send propagates without an auxiliary setup message or hidden retry',async t=>{
 const f=fixture(t),send=f.raw.sendMessage;let attempts=0;f.raw.sendMessage=async()=>{attempts++;throw new Error('timeout');};
 await assert.rejects(f.api.sendMessage(123,'Actual place opened'),/timeout/);await f.api.flushSiteLinks({force:true});assert.equal(attempts,1);
 f.raw.sendMessage=send;await f.api.sendMessage(123,'Next actual alert');assert.equal(f.messages.size,1);assert.ok(f.keyboards.has('123'));
});
test('old button cleanup yields to queued alerts and never sends a new message',async t=>{
 const f=fixture(t);await f.api.stopSiteLinks();f.store.state.siteLinks={'123':{pending:{40:{inline_keyboard:[]}}}};f.store.state.outbox=[{id:'pending',status:'queued',nextAt:Date.now()+60000}];const api=withFixedSiteShortcut(f.store,f.raw);
 try{await api.flushSiteLinks();assert.equal(f.edits.length,0);f.store.state.outbox=[];await api.flushSiteLinks();assert.equal(f.edits.length,1);assert.equal(f.messages.size,0);}finally{await api.stopSiteLinks();}
});
test('deploy, restart, and language setup never send a UI announcement in either language',async t=>{
 const f=fixture(t);await f.api.stopSiteLinks();f.store.setLanguage(456,'en');f.store.state.siteLinks={'123':{pending:{},introAttemptedLanguage:'tr'},'456':{pending:{},keyboardVersion:1,keyboardLanguage:'tr'}};f.store.save();
 const restored=new LocalStore(f.store.file,{accessMode:'public'}),api=withFixedSiteShortcut(restored,f.raw);
 try{
  await api.flushSiteLinks({force:true});assert.equal(f.messages.size,0);
  const d=createMenuDispatcher(restored,api);
  for(const chatId of [123,456]){const r=handleBotCommand(restored,{chat:{id:chatId,type:'private'},text:'/menu'});r.languageChanged=restored.languageFor(chatId);d.enqueue(r);}
  await d.drain();assert.equal(f.messages.size,2);assert.ok([...f.messages.values()].every(m=>!/(?:alttaki düğmeyi|button below)/i.test(m.text)));
 }finally{await api.stopSiteLinks();}
});
test('migration removes known former inline buttons but keeps text and other menu actions',async t=>{
 const f=fixture(t);await f.api.stopSiteLinks();f.store.state.siteLinks={'123':{latest:{id:40,base:{inline_keyboard:[[{text:'Selections',callback_data:'p'}]]}},pending:{}}};f.store.state.slotAlerts={a:{chatId:'123',messageId:41},b:{chatId:'456',messageId:50}};
 const api=withFixedSiteShortcut(f.store,f.raw);try{await api.sendMessage(123,'Actual alert');await api.flushSiteLinks({force:true});assert.deepEqual(f.edits.map(e=>e.id).sort(),[40,41]);assert.equal(f.edits.find(e=>e.id===40).markup.inline_keyboard[0][0].callback_data,'p');assert.equal(f.store.state.siteLinks['123'].latest,undefined);}finally{await api.stopSiteLinks();}
});
test('cleanup failures cannot change or replay a successful reservation alert',async t=>{
 const f=fixture(t);await f.api.stopSiteLinks();f.store.state.siteLinks={'123':{pending:{40:{inline_keyboard:[]}}}};f.raw.editMessageReplyMarkup=async()=>{throw new Error('timeout');};const api=withFixedSiteShortcut(f.store,f.raw);
 try{const r=await api.sendMessage(123,'Place opened');await api.flushSiteLinks({force:true});assert.ok(r.message_id);assert.equal(f.messages.size,1);assert.ok(f.keyboards.has('123'));}finally{await api.stopSiteLinks();}
});
test('configuration survives restart, does not clean new reply-keyboard messages, and is erased with the account',async t=>{
 const f=fixture(t);await f.api.sendMessage(123,'Alert');await f.api.stopSiteLinks();f.store.state.slotAlerts={a:{chatId:'123',messageId:1}};f.store.save();
 const restored=new LocalStore(f.store.file,{accessMode:'public'}),api=withFixedSiteShortcut(restored,f.raw);
 try{await api.flushSiteLinks({force:true});assert.equal(f.messages.size,1);assert.equal(f.edits.length,0);const r=handleBotCommand(restored,{chat:{id:123,type:'private'},text:'/delete'});assert.deepEqual(r.replyMarkup,{remove_keyboard:true});await api.sendMessage(r.chatId,r.text,r.replyMarkup);assert.equal(f.keyboards.has('123'),false);assert.equal(restored.state.siteLinks['123'],undefined);}finally{await api.stopSiteLinks();}
});
test('unapproved chats never receive or retain a fixed shortcut',async t=>{
 const f=fixture(t);await f.api.sendMessage(999,'Invite required');await f.api.flushSiteLinks({force:true});assert.equal(f.messages.size,1);assert.equal(f.keyboards.has('999'),false);assert.equal(f.store.state.siteLinks?.['999'],undefined);
});
test('keyboard payload uses only plain text and no URL/Web App browser-forcing scheme',()=>{
 for(const lang of ['tr','en']){const k=siteReplyKeyboard(lang);assert.equal(k.keyboard.flat().length,1);assert.doesNotMatch(JSON.stringify(k),/url|web_app|googlechrome|tg:\/\//);}
});
test('reply-only keyboard cleanup uses the shared rate limiter and correct Telegram payload',async()=>{
 let body,method,taken=0;const api=new TelegramApi('12345678:'+ 'A'.repeat(32),async(url,options)=>{method=url.split('/').at(-1);body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({ok:true,result:true})};},{take:async()=>taken++});
 await api.editMessageReplyMarkup(123,7,{inline_keyboard:[]});assert.equal(method,'editMessageReplyMarkup');assert.deepEqual(body,{chat_id:123,message_id:7,reply_markup:{inline_keyboard:[]}});assert.equal(taken,1);
});
