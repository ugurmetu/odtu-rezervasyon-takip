import test from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{startLocalServer}from'../src/server.mjs';
test('native endpoint keeps both local secret and exact extension-origin checks',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-native-route-')),key='a'.repeat(64),id='b'.repeat(32),calls=[];
 const server=await startLocalServer({port:0,key,extensionId:id,stateFile:join(folder,'state.json'),nativeVerification:{click:async(p,c)=>{calls.push({p,c});return{ok:true};}}});
 const port=server.server.address().port,url=`http://127.0.0.1:${port}/session/verification-click`;
 try{
 for(const headers of [{'Content-Type':'application/json'},{'Content-Type':'application/json','X-Local-Key':key},{'Content-Type':'application/json','X-Local-Key':key,'X-Rez-Extension':id,Origin:'https://other.invalid'}]){
  assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,403);
 }
 assert.equal(calls.length,0);
 const headers={'Content-Type':'application/json','X-Local-Key':key,'X-Rez-Extension':id};
 assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,403);
 assert.equal(calls.length,0);
 server.store.state.readerState={phase:'waiting_verification'};
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Key':key,'X-Rez-Extension':id,Origin:`chrome-extension://${id}`},body:JSON.stringify({requestId:'test-doc-123'})});
 assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.equal(calls.length,1);assert.equal(calls[0].c.phase,'waiting_verification');
 }finally{await server.close();rmSync(folder,{recursive:true,force:true});}
});

test('passive native readiness has the same local key and extension boundary and never sends input',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-native-ready-route-')),key='a'.repeat(64),id='b'.repeat(32);let calls=0,clicks=0;
 const s=await startLocalServer({port:0,key,extensionId:id,stateFile:join(folder,'state.json'),nativeVerification:{readiness:async()=>{calls++;return {ready:false,retryable:true};},click:async()=>{clicks++;}}});
 const url=s.url+'/session/verification-ready';try{
  for(const headers of [{},{'X-Local-Key':key},{'X-Local-Key':key,'X-Rez-Extension':id,Origin:'https://other.invalid'}])assert.equal((await fetch(url,{headers})).status,403);
  const r=await fetch(url,{headers:{'X-Local-Key':key,'X-Rez-Extension':id}});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ready:false,retryable:true});assert.equal(calls,1);assert.equal(clicks,0);
 }finally{await s.close();rmSync(folder,{recursive:true,force:true});}
});
test('refresh telemetry is bounded to safe codes and becomes resumed only with a valid later timestamp',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-refresh-route-')),key='a'.repeat(64),id='b'.repeat(32),s=await startLocalServer({port:0,key,extensionId:id,stateFile:join(folder,'state.json')});
 const headers={'X-Local-Key':key,'Content-Type':'application/json'},at=new Date(Date.now()-1000).toISOString();
 const send=autoRefresh=>fetch(s.url+'/reader-state',{method:'POST',headers,body:JSON.stringify({phase:'reconnecting',autoRefresh})});
 try{
  assert.equal((await send({at,reason:'primefaces_unavailable',outcome:'requested',secret:'ignore'})).status,200);assert.equal(s.store.state.readerAutoRefresh.secret,undefined);
  assert.equal((await send({at,reason:'not_a_safe_code',outcome:'requested'})).status,400);
  assert.equal((await send({at,reason:'primefaces_unavailable',outcome:'resumed',resumedAt:new Date(Date.parse(at)-1).toISOString()})).status,400);
  const resumedAt=new Date().toISOString();assert.equal((await send({at,reason:'primefaces_unavailable',outcome:'resumed',resumedAt})).status,200);assert.equal(s.store.status().readerAutoRefresh.resumedAt,resumedAt);
 }finally{await s.close();rmSync(folder,{recursive:true,force:true});}
});
