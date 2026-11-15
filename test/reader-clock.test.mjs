import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {attachReaderClock} from '../src/reader-clock.mjs';
const extensionId='testextension',key='a'.repeat(64);
async function fixture(){const server=createServer();const clock=attachReaderClock(server,{key,extensionId,tickMs:30});server.listen(0,'127.0.0.1');await once(server,'listening');return {clock,url:`ws://127.0.0.1:${server.address().port}/reader-clock`,close:()=>{clock.close();return new Promise(r=>server.close(r));}};}
function client(url,origin=`chrome-extension://${extensionId}`){return new WebSocket(url,'rez-v1',{origin});}
test('only the expected extension origin can open the loopback clock',async()=>{
 const f=await fixture();try{const ws=client(f.url,'https://untrusted.example');const [error]=await once(ws,'error');assert.match(error.message,/403/);assert.equal(f.clock.status().connected,false);}finally{await f.close();}
});
test('clock does not send a tick before authentication and rejects a wrong key',async()=>{
 const f=await fixture();try{const ws=client(f.url);await once(ws,'open');let messages=0;ws.on('message',()=>messages++);ws.send(JSON.stringify({type:'auth',key:'b'.repeat(64)}));const [code]=await once(ws,'close');assert.equal(code,1008);assert.equal(messages,0);assert.equal(f.clock.status().connected,false);}finally{await f.close();}
});
test('authenticated loopback ticks continue and closing the service closes the socket',async()=>{
 const f=await fixture();try{const ws=client(f.url);await once(ws,'open');const first=once(ws,'message');ws.send(JSON.stringify({type:'auth',key}));const [bytes]=await first;assert.equal(JSON.parse(bytes).type,'tick');assert.equal(f.clock.status().connected,true);const [next]=await once(ws,'message');assert.equal(JSON.parse(next).type,'tick');const closed=once(ws,'close');await f.close();await closed;}catch(e){await f.close();throw e;}
});

test('a new reader may negotiate a one-second local wakeup without changing the old default cadence',async()=>{const f=await fixture();try{const ws=client(f.url);await once(ws,'open');const first=once(ws,'message');ws.send(JSON.stringify({type:'auth',key,tickMs:1000}));await first;assert.equal(f.clock.status().tickMs,1000);ws.close();}finally{await f.close();}});
