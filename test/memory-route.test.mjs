import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startLocalServer} from '../src/server.mjs';
test('memory acknowledgement is authenticated, bounded and visible in local health',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-memory-route-')),key=randomBytes(32).toString('hex');
 const local=await startLocalServer({port:0,key,stateFile:join(folder,'state.json')});
 const headers={'x-local-key':key,'content-type':'application/json'};
 const body={phase:'preparing',maxFacilities:200,version:'0.10.2',singleTab:true,memoryGuard:true,memoryRecycle:{token:'a'.repeat(32),phase:'rotated',at:'2026-10-29T09:00:00Z',oldId:17,newId:23,arbitrary:'discard'}};
 try{
  assert.equal((await fetch(local.url+'/reader-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(local.url+'/reader-state',{method:'POST',headers,body:JSON.stringify(body)})).status,200);
  const health=await(await fetch(local.url+'/health',{headers})).json();
  assert.equal(health.readerCapabilities.memoryGuard,true);assert.deepEqual(Object.keys(health.readerMemoryRecycle),['token','phase','at']);
  assert.equal((await fetch(local.url+'/reader-state',{method:'POST',headers,body:JSON.stringify({...body,memoryRecycle:{...body.memoryRecycle,phase:'invalid'}})})).status,400);
 }finally{await local.close();rmSync(folder,{recursive:true,force:true});}
});
