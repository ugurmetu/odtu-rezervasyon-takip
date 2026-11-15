import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivateFileCredentialStore,MacCredentialStore,createCredentialStore} from '../src/credentials.mjs';
import {startLocalServer} from '../src/server.mjs';

const fixture=()=>{const folder=mkdtempSync(join(tmpdir(),'rez-linux-'));return {folder,file:join(folder,'credentials.json'),close:()=>rmSync(folder,{recursive:true,force:true})};};
const sample={username:'synthetic_user',password:'synthetic_password'};
test('Linux reads only a private, regular credential file and keeps it read-only through the application',async()=>{
 const f=fixture();try{writeFileSync(f.file,JSON.stringify(sample),{mode:0o600});const store=new PrivateFileCredentialStore(f.file);assert.deepEqual(await store.get(),sample);assert.deepEqual(await store.status(),{configured:true,available:true});await assert.rejects(store.set({}),/credentials_read_only/);chmodSync(f.file,0o400);assert.deepEqual(await store.get(),sample);}finally{f.close();}
});
test('missing, public-readable, executable, symlinked, oversized and malformed credential files fail closed',async()=>{
 const f=fixture();try{
  const store=new PrivateFileCredentialStore(f.file);await assert.rejects(store.get(),/^Error: credentials_missing$/);
  writeFileSync(f.file,JSON.stringify(sample),{mode:0o600});
  chmodSync(f.file,0o644);
  await assert.rejects(store.get(),/^Error: credentials_unavailable$/);
  chmodSync(f.file,0o700);await assert.rejects(store.get(),/credentials_unavailable/);
  chmodSync(f.file,0o600);const link=join(f.folder,'link.json');symlinkSync(f.file,link);await assert.rejects(new PrivateFileCredentialStore(link).get(),/credentials_unavailable/);
  writeFileSync(f.file,'x'.repeat(8193));await assert.rejects(store.get(),/credentials_unavailable/);
  writeFileSync(f.file,'private malformed content');await assert.rejects(store.get(),/^Error: credentials_unavailable$/);
  writeFileSync(f.file,JSON.stringify({username:'x',password:'private'}));await assert.rejects(store.get(),/^Error: credentials_unavailable$/);
  assert.deepEqual(await store.status(),{configured:false,available:false});assert.throws(()=>new PrivateFileCredentialStore('relative.json'),/invalid_credentials_file/);
 }finally{f.close();}
});
test('deployment platform selection preserves the Mac vault and never treats Windows mode bits as Linux protection',async()=>{
 assert.ok(createCredentialStore({platform:'darwin',credentialsFile:'/unused'}) instanceof MacCredentialStore);
 assert.ok(createCredentialStore({platform:'linux'}) instanceof PrivateFileCredentialStore);
 assert.deepEqual(await createCredentialStore({platform:'linux'}).status(),{configured:false,available:false});
 await assert.rejects(createCredentialStore({platform:'win32',credentialsFile:'/unused'}).get(),/credentials_unavailable/);
});
test('a deployment-specific extension identity is allowed while the old identity cannot read its credentials',async()=>{
 const f=fixture(),extensionId='a'.repeat(32),key='b'.repeat(64);let service;
 try{
  service=await startLocalServer({port:0,key,stateFile:join(f.folder,'state.json'),extensionId,credentialStore:{status:async()=>({configured:true,available:true}),get:async()=>sample}});
  const headers={'X-Local-Key':key,'X-Rez-Extension':extensionId,Origin:`chrome-extension://${extensionId}`};
  assert.equal((await fetch(service.url+'/session/status',{headers})).status,200);
  assert.equal((await fetch(service.url+'/session/credentials',{headers:{...headers,'X-Rez-Extension':'mjfddbpabfknhnpmhbdkfpjpefepomjn'}})).status,403);
  const text=await(await fetch(service.url+'/health',{headers})).text();assert.ok(!text.includes(sample.password));
  await assert.rejects(startLocalServer({port:0,key,stateFile:join(f.folder,'bad.json'),extensionId:'invalid'}),/invalid extension id/);
 }finally{if(service){service.server.closeAllConnections();await service.close();}f.close();}
});
