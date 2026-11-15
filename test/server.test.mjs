import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalServer, validateBotStartup } from '../src/server.mjs';

function rawStatus(port, target, key = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(3000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('connect', () => socket.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${key ? `X-Local-Key: ${key}\r\n` : ''}Connection: close\r\n\r\n`
    ));
    socket.on('data', chunk => {
      const status = /^HTTP\/1\.1 (\d{3})\b/.exec(chunk.toString('utf8'))?.[1];
      if (!status) return;
      resolve(Number(status));
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

test('a bot cannot start without its invite while a local-only demo may run', () => {
  const syntheticToken = `12345678:${'A'.repeat(30)}`;
  assert.doesNotThrow(() => validateBotStartup('', ''));
  assert.throws(() => validateBotStartup(syntheticToken, ''), /invite code is missing/);
  assert.throws(() => validateBotStartup('invalid', 'test_only_invite_code_2026'), /invalid Telegram bot token/);
  assert.doesNotThrow(() => validateBotStartup(syntheticToken, 'test_only_invite_code_2026'));
});

test('local listener authenticates requests and rejects malformed snapshots', async () => {
  const key = randomBytes(32).toString('hex');
  const folder = mkdtempSync(join(tmpdir(), 'rez-server-test-'));
  const listener = await startLocalServer({ port: 0, key, stateFile: join(folder, 'state.json') });
  try {
    const denied = await fetch(`${listener.url}/health`);
    assert.equal(denied.status, 403);
    const good = await fetch(`${listener.url}/health`, { headers: { 'x-local-key': key } });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
    const malformed = await fetch(`${listener.url}/ingest`, {
      method: 'POST', headers: { 'x-local-key': key, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(malformed.status, 400);
    const wrongType = await fetch(`${listener.url}/ingest`, { method: 'POST', headers: { 'x-local-key': key }, body: '{}' });
    assert.equal(wrongType.status, 415);
    assert.equal(listener.store.status().queued, 0);
  } finally {
    await listener.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a malformed raw request target cannot stop the local listener', async () => {
  const key = randomBytes(32).toString('hex');
  const folder = mkdtempSync(join(tmpdir(), 'rez-raw-request-test-'));
  const listener = await startLocalServer({ port: 0, key, stateFile: join(folder, 'state.json') });
  try {
    const port = listener.server.address().port;
    assert.equal(await rawStatus(port, '//%5B'), 403);
    assert.equal(await rawStatus(port, '//%5B', key), 400);
    const health = await fetch(`${listener.url}/health`, { headers: { 'x-local-key': key } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await listener.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('health exposes only a fixed diagnostic code from an unavailable capture', async () => {
  const key = randomBytes(32).toString('hex');
  const folder = mkdtempSync(join(tmpdir(), 'rez-diagnostic-test-'));
  const listener = await startLocalServer({ port: 0, key, stateFile: join(folder, 'state.json') });
  const send = async detail => {
    const response = await fetch(`${listener.url}/ingest`, {
      method: 'POST',
      headers: { 'x-local-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, source: 'rez-calendar-extension',
        state: 'calendar_unavailable', observed_at: new Date().toISOString(), fresh: false,
        detail, facility: null, view: { type: 'unknown', date: null }, slots: [] })
    });
    assert.equal(response.status, 200);
  };
  try {
    await send('no_schedule_request');
    assert.equal(listener.store.status().lastDiagnostic, 'no_schedule_request');
    await send('content_unreachable');
    assert.equal(listener.store.status().lastDiagnostic, 'content_unreachable');
    await send('calendar_date_expired');
    assert.equal(listener.store.status().lastDiagnostic, 'calendar_date_expired');
    await send('calendar_day_advanced');
    assert.equal(listener.store.status().lastDiagnostic, 'calendar_day_advanced');
    await send('calendar_day_advance_failed');
    assert.equal(listener.store.status().lastDiagnostic, 'calendar_day_advance_failed');
    await send('private-user-data');
    assert.equal(listener.store.status().lastDiagnostic, null);
  } finally {
    await listener.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('local authenticated catalog accepts only verified shaped facility metadata', async () => {
  const key = randomBytes(32).toString('hex');
  const folder = mkdtempSync(join(tmpdir(), 'rez-catalog-test-'));
  const listener = await startLocalServer({ port: 0, key, stateFile: join(folder, 'state.json') });
  const post = (body, headers = { 'x-local-key': key, 'content-type': 'application/json' }) => fetch(`${listener.url}/catalog`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  try {
    assert.equal((await post({ facilities: [] }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await post({ facilities: [{ id: '17', label: 'Fitness', unit: '' }] })).status, 400);
    assert.equal((await post({ facilities: [{ id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' }] })).status, 200);
    assert.equal(listener.store.availableFacilities()[0].unit, 'Spor Müdürlüğü');
    assert.equal(listener.store.availableFacilities()[0].observed, false);
  } finally {
    await listener.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('verified weekly batch ingests each date and rejects malformed batches before changing history', async () => {
  const key = randomBytes(32).toString('hex');
  const folder = mkdtempSync(join(tmpdir(), 'rez-week-test-'));
  const listener = await startLocalServer({port:0,key,stateFile:join(folder,'state.json')});
  listener.store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);
  const snapshot = date => ({schema:1, source:'rez-calendar-extension', observed_at:new Date().toISOString(),
    state:'ok',fresh:true,refresh_id:'week_refresh_12345678',facility:{id:'17',label:'Baraka'},
    view:{type:'day',date},slots:[]});
  const send = snapshots => fetch(`${listener.url}/ingest`,{method:'POST',headers:{'x-local-key':key,
    'content-type':'application/json','connection':'close'},body:JSON.stringify({snapshots})});
  try {
    const dates=['2026-10-28','2026-10-29','2026-10-30'];
    assert.equal((await send(dates.map(snapshot))).status,200);
    assert.equal(Object.keys(listener.store.engine.pages).length,3);
    assert.equal((await send([snapshot('2026-10-31'),{}])).status,400);
    assert.equal(Object.keys(listener.store.engine.pages).length,3);
    assert.equal((await send([snapshot(dates[0]),snapshot(dates[0])])).status,400);
  } finally { listener.server.closeAllConnections(); await listener.close(); rmSync(folder,{recursive:true,force:true}); }
});

test('a maintenance handshake records actual single-tab version without replacing the existing calendar plan',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-single-cap-')),key=randomBytes(32).toString('hex');
 const listener=await startLocalServer({port:0,key,stateFile:join(folder,'state.json')});
 try{
  const old=listener.store.state.readerPlan;
  const response=await fetch(`${listener.url}/reader-state`,{method:'POST',headers:{'x-local-key':key,'content-type':'application/json'},body:JSON.stringify({phase:'paused',version:'0.8.0',singleTab:true,parallelRead:true,catalogDiscovery:true,maxFacilities:200})});
  assert.equal(response.status,200);assert.deepEqual(listener.store.state.readerPlan,old);assert.equal(listener.store.state.readerCapabilities.singleTab,true);assert.equal(listener.store.state.readerCapabilities.parallelRead,false);
 }finally{await listener.close();rmSync(folder,{recursive:true,force:true});}
});

test('reader read statistics are kept in memory and repeated unchanged phases do not rewrite the state file',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-read-stats-')),key=randomBytes(32).toString('hex');
 const listener=await startLocalServer({port:0,key,stateFile:join(folder,'state.json')});
 try{
  let saves=0;const save=listener.store.save.bind(listener.store);listener.store.save=()=>{saves++;return save();};
  const post=body=>fetch(`${listener.url}/reader-state`,{method:'POST',headers:{'x-local-key':key,'content-type':'application/json'},body:JSON.stringify({version:'0.9.0',singleTab:true,catalogDiscovery:true,maxFacilities:200,...body})});
  assert.equal((await post({phase:'ready',readStats:{reused:true,selectionVerified:true,actions:1,ms:640,requests:{unit:0,facility:1,schedule:1}}})).status,200);
  for(let i=0;i<5;i++)assert.equal((await post({phase:'ready',readStats:{reused:false,selectionVerified:true,actions:2,ms:1500,requests:{unit:0,facility:1,schedule:1},secret:'x'}})).status,200);
  assert.equal(saves,1,'only the first phase change is persisted at once');
  assert.equal((await post({phase:'preparing'})).status,200);assert.equal(saves,2);
  const stats=listener.store.status().readerStats;
  assert.equal(stats.samples,6);assert.equal(stats.reused,1);assert.equal(stats.selectionVerified,6);assert.equal(stats.avgActions,1.83);assert.equal(stats.maxMs,1500);
  assert.equal(JSON.stringify(stats).includes('secret'),false);
 }finally{await listener.close();rmSync(folder,{recursive:true,force:true});}
});


test('official proof refresh is authenticated, known-scope only, fresh, and never alters menus or availability',async()=>{
 const key=randomBytes(32).toString('hex'),folder=mkdtempSync(join(tmpdir(),'rez-proof-route-'));
 const x=await startLocalServer({port:0,key,stateFile:join(folder,'state.json')});try{
  const date='2026-11-04',old=new Date(Date.now()-7200000).toISOString();
  x.store.setFacilityCatalog([{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]);x.store.state.readerPlan={facilityIds:['17'],dates:[date]};
  x.store.setSessionCatalog('17',date,[{start:'08:00',end:'09:30'}],old);
  x.store.state.sessionCatalog['17|'+date]={source:'weekly-publication',verifiedAt:old,sessions:[{start:'08:00',end:'09:30'},{start:'10:00',end:'11:30'}]};
  const menu=structuredClone(x.store.state.sessionCatalog),engine=structuredClone(x.store.engine.pages),prefs=structuredClone(x.store.state.subscriptions);
  const v={facilityId:'17',date,source:'official-booking-form',verifiedAt:new Date().toISOString(),sessions:[{start:'08:00',end:'09:30'}]};
  const post=(value,auth=key)=>fetch(x.url+'/catalog/official-session-proof',{method:'POST',headers:{'X-Local-Key':auth,'content-type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post(v,'')).status,403);
  for(const bad of [{...v,date:'2026-11-05'},{...v,source:'weekly-publication'},{...v,verifiedAt:old},{...v,verifiedAt:new Date(Date.now()+10000).toISOString()},{...v,sessions:[{start:'20:00',end:'20:00'}]}])assert.equal((await post(bad)).status,400);
  assert.equal((await post(v)).status,200);assert.equal(x.store.status().sessionCatalog['17|'+date].verifiedAt,v.verifiedAt);
  assert.deepEqual(x.store.state.sessionCatalog,menu);assert.deepEqual(x.store.engine.pages,engine);assert.deepEqual(x.store.state.subscriptions,prefs);assert.equal(x.store.status().queued,0);
 }finally{await x.close();rmSync(folder,{recursive:true,force:true});}
});

test('ingest acknowledges only proven publication waiting and withdraws it after a real future-day read',async t=>{
 const now=Date.parse('2026-11-15T20:00:00+03:00');t.mock.method(Date,'now',()=>now);
 const key=randomBytes(32).toString('hex'),dir=mkdtempSync(join(tmpdir(),'rez-publication-route-'));
 const listener=await startLocalServer({port:0,key,stateFile:join(dir,'state.json')});
 try{
  const store=listener.store;store.setFacilityCatalog([{id:'17',label:'Baraka',unit:'Spor Müdürlüğü'}]);
  store.state.readerState={phase:'reconnecting'};store.state.readerPlan={facilityIds:['17'],dates:Array.from({length:7},(_,i)=>'2026-11-'+String(16+i))};
  const post=body=>fetch(listener.url+'/ingest',{method:'POST',headers:{'x-local-key':key,'content-type':'application/json','connection':'close'},body:JSON.stringify(body)}).then(r=>r.json());
  const bad={schema:1,source:'rez-calendar-extension',observed_at:new Date(now).toISOString(),state:'calendar_unavailable',fresh:false,detail:'calendar_date_mismatch',facility:null,view:{type:'unknown',date:null},slots:[]};
  assert.equal((await post(bad)).waitingPublication,true);assert.equal(store.status().reader.phase,'waiting_publication');assert.equal(store.status().reader.fresh,0);
  assert.notEqual((await post({...bad,detail:'timeout'})).waitingPublication,true);
  await post({schema:1,source:'rez-calendar-extension',observed_at:new Date(now).toISOString(),state:'ok',fresh:true,refresh_id:'publication_proof_1234',facility:{id:'17',label:'Baraka'},view:{type:'day',date:'2026-11-16'},slots:[]});
  assert.notEqual((await post(bad)).waitingPublication,true,'one real new-week read ends the exception');
 }finally{await listener.close();listener.store.flushSave();rmSync(dir,{recursive:true,force:true});}
});
