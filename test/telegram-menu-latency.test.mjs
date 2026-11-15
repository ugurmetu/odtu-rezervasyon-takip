import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {createMenuDispatcher,runTelegramLoop} from '../src/telegram.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rez-menu-'));const store=new LocalStore(join(dir,'state.json'),{betaInviteCode:'test_menu_invite_2026'});store.approveBetaChat(123,'test_menu_invite_2026');return {store,close:()=>rmSync(dir,{recursive:true,force:true})};}
test('slow menu transport does not prevent the next long poll', {timeout:2000}, async()=>{
 const f=fixture(),controller=new AbortController(),blocked=deferred(),polledAgain=deferred(),pollStop=deferred();let polls=0;
 const api={getUpdates:async()=>++polls===1?[{update_id:1,callback_query:{id:'one',from:{id:123},message:{message_id:9,chat:{id:123,type:'private'}},data:'h'}}]:(polledAgain.resolve(),pollStop.promise),answerCallbackQuery:async()=>{},editMessageText:async()=>blocked.promise};
 const running=runTelegramLoop(f.store,api,controller.signal);
 try{await polledAgain.promise;assert.equal(f.store.state.telegramOffset,2);assert.ok(polls>=2);}
 finally{controller.abort();blocked.resolve();pollStop.resolve([]);await running;f.close();}
});
test('menus stay ordered within a chat and pending edits collapse to the newest screen',async()=>{
 const f=fixture(),blocked=deferred(),seen=[];
 const d=createMenuDispatcher(f.store,{editMessageText:async(chat,id,text)=>{seen.push([chat,text]);if(text==='first')await blocked.promise;}});
 d.enqueue({chatId:123,editMessageId:9,text:'first'});
 d.enqueue({chatId:123,editMessageId:9,text:'obsolete'});
 d.enqueue({chatId:123,editMessageId:9,text:'latest'});
 d.enqueue({chatId:456,editMessageId:4,text:'other chat'});
 await Promise.resolve();assert.deepEqual(seen,[[123,'first'],[456,'other chat']]);
 blocked.resolve();await d.drain();assert.deepEqual(seen,[[123,'first'],[456,'other chat'],[123,'latest']]);f.close();
});
test('a rate-limited chat does not block another chat or the availability queue',async()=>{
 const f=fixture(),seen=[];const d=createMenuDispatcher(f.store,{editMessageText:async(chat)=>{seen.push(chat);if(chat===123)throw Object.assign(new Error('limited'),{status:429,retryAfterMs:30000});}});
 d.enqueue({chatId:123,editMessageId:9,text:'first'});d.enqueue({chatId:456,editMessageId:9,text:'second'});await d.drain();assert.deepEqual(seen,[123,456]);assert.equal(f.store.canSendMenuReply(123),false);assert.equal(f.store.canSendMenuReply(456),true);f.close();
});
