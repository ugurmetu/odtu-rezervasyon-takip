import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../verification-content.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({scope=true,paused=true,candidate=true,results=null}={}){
  let listener,attempts=0,disconnected=0,observed=0,permission;
  const messages=[],document={},shadow={},timers=new Map();let timerId=0;
  const context={location:{},document,queueMicrotask,getComputedStyle:()=>({}),setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    MutationObserver:class{observe(){observed++;}disconnect(){disconnected++;}},
    RezVerificationCheckbox:{inScope:()=>scope,create:env=>{permission=env;return {
      find:()=>({outcome:candidate?'candidate':'no_checkbox',roots:[shadow]}),
      attempt:async()=>{attempts++;const result=results?.[Math.min(attempts-1,results.length-1)];if(result instanceof Error)throw result;return result||{attempted:true,outcome:'clicked'};}
    };}},chrome:{dom:{},storage:{local:{get:async()=>({paused})},onChanged:{addListener:f=>listener=f}},runtime:{sendMessage:async value=>{messages.push(value);return {allowed:true};}}}};
  runInNewContext(source,context);
  return {messages,change:value=>listener({paused:{newValue:value}}),listener:()=>listener,attempts:()=>attempts,disconnected:()=>disconnected,observed:()=>observed,permission:()=>permission,timers:()=>timers.size,fireTimer:()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}};
}
test('an unrelated frame installs no observers and sends no verification messages',async()=>{
  const f=fixture({scope:false,paused:false});await flush();assert.equal(f.listener(),undefined);assert.equal(f.observed(),0);assert.equal(f.messages.length,0);
});
test('paused collection leaves verification idle; resume permits one attempt and disconnects observers',async()=>{
  const f=fixture();await flush();assert.equal(f.attempts(),0);assert.equal(f.observed(),0);
  f.change(false);await flush();assert.equal(f.attempts(),1);assert.equal(f.disconnected(),2);
  assert.equal(f.messages[0].type,'rez-verification:attempt');assert.equal(f.messages[0].outcome,'clicked');
  f.change(true);f.change(false);await flush();assert.equal(f.attempts(),1);
});
test('pausing a pending widget disconnects observation and disables its core',async()=>{
  const f=fixture({paused:false,candidate:false});await flush();assert.equal(f.observed(),2);assert.equal(f.permission().isEnabled(),true);
  f.change(true);assert.equal(f.disconnected(),2);assert.equal(f.permission().isEnabled(),false);assert.equal(f.attempts(),0);
});

test('temporary permission denial wakes again without a DOM change and stops after one actual attempt',async()=>{
 const f=fixture({paused:false,results:[{attempted:false,outcome:'not_authorized',retryable:true},{attempted:true,outcome:'clicked'}]});
 await flush();assert.equal(f.attempts(),1);assert.equal(f.messages.length,0);assert.equal(f.timers(),1);
 f.fireTimer();await flush();assert.equal(f.attempts(),2);assert.equal(f.messages.length,1);assert.equal(f.timers(),0);
 f.change(true);f.change(false);await flush();assert.equal(f.attempts(),2);
});
test('Stop cancels a pending permission retry; a permanent denial never schedules one',async()=>{
 const f=fixture({paused:false,results:[{attempted:false,outcome:'not_authorized',retryable:true}]});await flush();assert.equal(f.timers(),1);f.change(true);assert.equal(f.timers(),0);
 const denied=fixture({paused:false,results:[{attempted:false,outcome:'not_authorized',retryable:false}]});await flush();assert.equal(denied.timers(),0);
});

test('a worker transport failure before authorisation retries permission without needing a page reload',async()=>{
 const f=fixture({paused:false,results:[new Error('worker starting'),{attempted:true,outcome:'clicked'}]});await flush();assert.equal(f.messages.length,0);assert.equal(f.timers(),1);f.fireTimer();await flush();assert.equal(f.messages.length,1);assert.equal(f.timers(),0);
});
