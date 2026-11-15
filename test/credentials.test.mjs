import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {validateCredentials} from '../src/credentials.mjs';
import {startLocalServer} from '../src/server.mjs';

test('credential validation rejects unusable values without exposing their content',()=>{
 assert.throws(()=>validateCredentials({username:'x',password:'secret'}),/^Error: invalid_credentials$/);
 assert.equal(validateCredentials({username:'e123456',password:'example_not_real'}).username,'e123456');
});
test('credential endpoints require the local key, installed extension identity and matching origin',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-credentials-test-'));
 let writes=0;const credentials={username:'e123456',password:'example_not_real'};
 const service=await startLocalServer({port:0,key:'a'.repeat(64),stateFile:join(folder,'state.json'),credentialStore:{
  async status(){return {configured:true,available:true};},async get(){return credentials;},async set(v){writes++;validateCredentials(v);return {configured:true};}}});
 const good={'x-local-key':'a'.repeat(64),'x-rez-extension':'mjfddbpabfknhnpmhbdkfpjpefepomjn',origin:'chrome-extension://mjfddbpabfknhnpmhbdkfpjpefepomjn'};
 try{
  assert.equal((await fetch(service.url+'/session/credentials')).status,403);
  assert.equal((await fetch(service.url+'/session/credentials',{headers:{'x-local-key':'a'.repeat(64)}})).status,403);
  assert.equal((await fetch(service.url+'/session/credentials',{headers:{...good,origin:'https://other.invalid'}})).status,403);
  const status=await (await fetch(service.url+'/session/status',{headers:good})).json();assert.deepEqual(status,{configured:true,available:true});
  const read=await (await fetch(service.url+'/session/credentials',{headers:good})).json();assert.equal(read.username,'e123456');
  const health=await (await fetch(service.url+'/health',{headers:good})).text();assert(!health.includes(credentials.password));
  assert.equal((await fetch(service.url+'/session/credentials',{method:'POST',headers:{...good,'content-type':'application/json'},body:JSON.stringify(credentials)})).status,200);
  assert.equal(writes,1);
 }finally{service.server.closeAllConnections();await service.close();rmSync(folder,{recursive:true,force:true});}
});
