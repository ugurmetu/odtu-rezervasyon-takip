import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOperatorChannel,configureOperatorChannel,isOperatorChannel} from '../src/operator-alerts.mjs';
import {checkCoverage,checkDeliveryHealth,checkTelegramPolling,runCoverageLoop} from '../src/coverage.mjs';
import {redirectReply} from '../src/legacy-redirect.mjs';
import {LocalStore} from '../src/store.mjs';
import {handleBotCommand} from '../src/telegram.mjs';

const main='123456789:'+ 'a'.repeat(32),ops='987654321:'+ 'b'.repeat(32);
function factory({sameBot=false,type='private',chatId=123,fail=false}={}){
 const sent=[];
 return {sent,apiFactory:token=>({
  async call(method){if(fail)throw new Error('unavailable');return method==='getMe'?{id:token===main||sameBot?1:2,is_bot:true}:{id:chatId,type};},
  async sendMessage(chatId,text){sent.push({bot:token===main?'public':'operator',chatId,text});return {message_id:1};}
 })};
}
test('only a verified distinct bot and the exact private owner produce a channel',async()=>{
 const f=factory();const r=await configureOperatorChannel({publicToken:main,operatorToken:ops,ownerChatId:123,apiFactory:f.apiFactory});
 assert.equal(r.reason,'ready');assert.equal(isOperatorChannel(r.channel,123),true);assert.equal(isOperatorChannel(r.channel,456),false);
 await r.channel.sendMessage(123,'synthetic operator test');assert.deepEqual(f.sent,[{bot:'operator',chatId:'123',text:'synthetic operator test'}]);
 await assert.rejects(r.channel.sendMessage(456,'not allowed'),/operator_recipient_forbidden/);
});
test('same token, same bot under another token, group, wrong private chat and network error never fall back to the public bot',async()=>{
 for(const options of [{operatorToken:main},{sameBot:true},{type:'group'},{chatId:456},{fail:true},{operatorToken:''}]){
  const f=factory(options),r=await configureOperatorChannel({publicToken:main,operatorToken:options.operatorToken??ops,ownerChatId:123,apiFactory:f.apiFactory});
  assert.equal(r.channel,null);assert.equal(f.sent.length,0);
 }
});
test('a bound channel cannot be expanded, and never exposes the raw API or token',()=>{
 const channel=createOperatorChannel({token:'secret',sendMessage:async()=>{}},123);
 assert.equal(Object.isFrozen(channel),true);assert.equal(channel.token,undefined);assert.equal(channel.call,undefined);
 assert.throws(()=>createOperatorChannel({sendMessage:async()=>{}},-123));
});
test('all technical health paths reject a plain public sender, including the configured owner',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-ops-reject-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new LocalStore(join(dir,'state.json'),{accessMode:'public'});store.admitChat(123);store.setTelegramConfigured(true);
 store.state.readerState={phase:'waiting_verification'};store.state.coverageNotice={kind:'waiting_verification',since:Date.now()-300000,alerted:false};
 store.state.outbox.push({id:'fake-loss',status:'failed',failedAt:new Date().toISOString()});
 const api={sendMessage:async()=>assert.fail('technical message reached public bot')};
 for(const check of [checkCoverage,checkDeliveryHealth,checkTelegramPolling])assert.equal(await check(store,api,123),'disabled');
 await runCoverageLoop(store,api,123,new AbortController().signal);
});
test('operator delivery remains private even when the owner has no public bot subscription',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-ops-owner-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new LocalStore(join(dir,'state.json'),{accessMode:'public'}),now=Date.now(),sent=[];
 assert.equal(store.isChatAllowed(123),false);
 store.state.readerState={phase:'waiting_verification'};store.state.coverageNotice={kind:'waiting_verification',since:now-130000,alerted:false};
 const channel=createOperatorChannel({sendMessage:async(id,text)=>sent.push({id,text})},123);
 assert.equal(await checkCoverage(store,channel,456,now),'disabled');assert.equal(await checkCoverage(store,channel,123,now),'alerted');
 assert.equal(sent.length,1);assert.equal(sent[0].id,'123');assert.match(sent[0].text,/Yönetici işlemi gerekiyor/);
 assert.doesNotMatch(sent[0].text,/Senin bir işlem|kullanıcı kontrolü/);
 assert.equal(await checkCoverage(store,channel,123,now+3600000),'already_alerted');
});
test('old links still redirect everybody else; only the owner sees the operator greeting',()=>{
 const update=id=>({message:{chat:{id,type:'private'},text:'/start'}});
 assert.match(redirectReply(update(123),{operatorOwnerId:'123'}).text,/Rezervasyon yönetimi/);
 const other=redirectReply(update(456),{operatorOwnerId:'123'});assert.match(other.text,/yeni adresine taşındı/);assert.doesNotMatch(other.text,/Teknik|doğrulama|sunucu/);
});

test('public menus never ask subscribers to fix the server, credentials or verification',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-ops-menus-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new LocalStore(join(dir,'state.json'),{accessMode:'public'});store.admitChat(123);
 for(const plan of [null,{facilityIds:['17'],dates:['2026-10-30']}]){
  store.state.readerPlan=plan;store.state.readerState={phase:'waiting_verification'};
  for(const lang of ['tr','en']){
   store.setLanguage(123,lang);
   for(const command of ['/start','/status']){
    const reply=handleBotCommand(store,{chat:{id:123,type:'private'},from:{id:123},text:command});
    assert.doesNotMatch(reply.text,/Mac|Chrome|doğrulama|verification|credentials|giriş bilg|işlem yapman|your attention/i);
   }
  }
 }
});
