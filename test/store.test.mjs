import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, sessionCoverage, sessionRegistrationClosed } from '../src/store.mjs';

test('sports and pool bookings close one hour after start while other units keep their own rule', () => {
  const slot = { date: '2026-10-19', start: '11:00', end: '12:45' };
  assert.equal(sessionRegistrationClosed(slot, 'Spor Müdürlüğü',
    Date.parse('2026-10-19T08:59:00Z')), false);
  assert.equal(sessionRegistrationClosed(slot, 'Spor Müdürlüğü',
    Date.parse('2026-10-19T09:00:00Z')), true);
  assert.equal(sessionRegistrationClosed(slot, 'Havuz Müdürlüğü',
    Date.parse('2026-10-19T08:59:00Z')), false);
  assert.equal(sessionRegistrationClosed(slot, 'Havuz Müdürlüğü',
    Date.parse('2026-10-19T09:00:00Z')), true);
  assert.equal(sessionRegistrationClosed(slot, 'Diğer Birim',
    Date.parse('2026-10-19T09:00:00Z')), false);
});

test('sports and pool coverage excludes sessions whose registration window closed', () => {
  const date = '2026-10-19';
  const page = { slots: {
    [`${date}|11:00|12:45`]: { free: 1 },
    [`${date}|14:00|15:40`]: { free: 1 }
  }, observedSlotKeys: [`${date}|14:00|15:40`] };
  const at = Date.parse('2026-10-19T09:05:00Z');
  assert.deepEqual(sessionCoverage(page, at, 'Spor Müdürlüğü'),
    { observedSessions: 1, recordedSessions: 1, intermittent: false });
  assert.deepEqual(sessionCoverage(page, at, 'Havuz Müdürlüğü'),
    { observedSessions: 1, recordedSessions: 1, intermittent: false });
  assert.deepEqual(sessionCoverage(page, at, 'Diğer Birim'),
    { observedSessions: 1, recordedSessions: 2, intermittent: true });
});

test('queued sports and pool alerts expire when registration closes before delivery', t => {
  t.mock.timers.enable({apis:['Date'], now:Date.parse('2026-10-19T09:00:00Z')});
  const folder = mkdtempSync(join(tmpdir(), 'rez-sports-window-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'));
    store.setFacilityCatalog([
      { id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' },
      { id: '21', label: 'Havuz', unit: 'Havuz Müdürlüğü' }
    ]);
    for (const [id, label] of [['17', 'Fitness'], ['21', 'Havuz']]) {
      store.state.outbox.push({ id: `late-${id}`, chatId: '123', status: 'queued',
        attempts: 0, nextAt: Date.parse('2026-10-19T08:59:00Z'),
        event: { facility: { id, label }, date: '2026-10-19',
          start: '11:00', end: '12:45', free: 1,
          observedAt: '2026-10-19T08:59:00Z' } });
    }
    assert.equal(store.dueDeliveries(Date.parse('2026-10-19T09:00:00Z')).length, 0);
    assert.deepEqual(store.state.outbox.map(item => item.reason),
      ['registration_closed', 'registration_closed']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('partial session coverage excludes hours already ended in Istanbul', () => {
  const date = '2026-10-19';
  const page = {
    slots: {
      [`${date}|08:00|09:30`]: { free: 1 },
      [`${date}|12:00|13:30`]: { free: 1 },
      [`${date}|14:00|15:40`]: { free: 1 }
    },
    observedSlotKeys: [`${date}|14:00|15:40`]
  };
  assert.deepEqual(sessionCoverage(page, Date.parse('2026-10-19T09:00:00Z')),
    { observedSessions: 1, recordedSessions: 2, intermittent: true });
  assert.deepEqual(sessionCoverage(page, Date.parse('2026-10-19T14:00:00Z')),
    { observedSessions: 0, recordedSessions: 0, intermittent: false });
});

test('store health counts every subscribed facility without revealing identities', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-facility-health-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'));
    store.setFacilityCatalog([
      { id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' },
      { id: '21', label: 'Pool', unit: 'Havuz Müdürlüğü' }
    ]);
    store.state.subscriptions = [
      { chatId: '123', facilityId: '17', active: true },
      { chatId: '123', facilityId: '21', active: true }
    ];
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 48 * 60 * 60_000));
    const slot = `${day}|11:00|12:45`;
    const page = id => ({ facility: { id }, date: day, lastSuccessAt: new Date().toISOString(),
      slots: { [slot]: { free: 1 } }, observedSlotKeys: [slot] });
    store.engine.pages = { a: page('17') };
    store.engine.health.lastState = 'ok';
    assert.deepEqual(store.status().subscribedFacilityCoverage,
      { subscribed: 2, fresh: 1, complete: 1 });
    store.engine.pages.b = page('21');
    assert.deepEqual(store.status().subscribedFacilityCoverage,
      { subscribed: 2, fresh: 2, complete: 2 });
    store.engine.pages.b.observedSlotKeys = [];
    assert.deepEqual(store.status().subscribedFacilityCoverage,
      { subscribed: 2, fresh: 2, complete: 1 });
    store.engine.pages.b.slots = {};
    assert.deepEqual(store.status().subscribedFacilityCoverage,
      { subscribed: 2, fresh: 2, complete: 1 });
    store.engine.health.lastState = 'calendar_unavailable';
    assert.deepEqual(store.status().subscribedFacilityCoverage,
      { subscribed: 2, fresh: 0, complete: 0 });
    assert.doesNotMatch(JSON.stringify(store.status().subscribedFacilityCoverage), /Fitness|Pool|123|17|21/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a delayed vacancy is not delivered after restart and expiry survives another restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-stale-delivery-'));
  const file = join(folder, 'state.json');
  try {
    const observedAt = new Date().toISOString();
    const futureDay = new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10);
    const first = new LocalStore(file);
    first.state.outbox.push({
      id: 'vacancy', chatId: '123', status: 'queued', attempts: 0,
      nextAt: Date.now(),
      event: { facility: { id: '17', label: 'Fitness' }, date: futureDay,
        start: '11:00', end: '12:45', free: 1, observedAt }
    });
    first.save();

    const afterRestart = new LocalStore(file);
    assert.equal(afterRestart.dueDeliveries(Date.now() + 6 * 60_000).length, 0);
    assert.equal(afterRestart.status().queued, 0);
    assert.equal(afterRestart.status().expired, 1);
    assert.match(afterRestart.status().lastExpiredAt, /^\d{4}-\d{2}-\d{2}T/);

    const finalRestart = new LocalStore(file);
    assert.equal(finalRestart.dueDeliveries(Date.now() + 6 * 60_000).length, 0);
    assert.equal(finalRestart.state.outbox[0].reason, 'stale_availability');
    assert.equal(finalRestart.state.outbox[0].event, undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('send start checks the vacancy deadline again after it was selected', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-start-after-expiry-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'));
    const event = { facility: { id: '17', label: 'Fitness' },
      date: new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10),
      start: '11:00', end: '12:45', free: 1,
      observedAt: new Date().toISOString() };
    store.state.outbox.push({ id: 'near-deadline', chatId: '123', event,
      attempts: 0, nextAt: Date.now() - 1, status: 'queued' });
    store.save();
    assert.equal(store.dueDeliveries().length, 1);
    store.state.outbox[0].event.observedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    assert.equal(store.beginDelivery('near-deadline'), false);
    assert.equal(store.state.outbox[0].status, 'expired');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a recent queued alert loaded after restart waits for its own session to be freshly verified', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-restart-revalidation-'));
  const file = join(folder, 'state.json');
  try {
    const date = '2099-10-19';
    const invite = 'test_invite_code_2026';
    const initial = new LocalStore(file, { betaInviteCode: invite });
    initial.setFacilityCatalog([
      { id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' },
      { id: '21', label: 'Havuz', unit: 'Havuz Müdürlüğü' }
    ]);
    assert.equal(initial.approveBetaChat(123, invite), 'approved');
    initial.state.outbox.push({ id: 'recent', chatId: '123', status: 'queued', attempts: 0,
      nextAt: Date.now() - 1, event: { facility: { id: '17', label: 'Fitness' },
        date, start: '11:00', end: '12:45', free: 2,
        observedAt: new Date(Date.now() - 20_000).toISOString() } });
    initial.save();

    const restored = new LocalStore(file, { betaInviteCode: invite });
    const reading = (facilityId, fresh, free, id) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: new Date().toISOString(), fresh,
      ...(fresh ? { refresh_id: id } : {}),
      facility: { id: facilityId, label: facilityId === '17' ? 'Fitness' : 'Havuz' },
      view: { type: 'day', date },
      slots: [{ date, start: '11:00', end: '12:45', free }]
    });
    assert.deepEqual(restored.dueDeliveries(), []);
    restored.ingest(reading('17', false, 2));
    assert.deepEqual(restored.dueDeliveries(), []);
    restored.ingest(reading('21', true, 2, 'other001'));
    assert.deepEqual(restored.dueDeliveries(), []);
    restored.ingest(reading('17', true, 2, 'fitness01'));
    assert.deepEqual(restored.dueDeliveries().map(item => item.id), ['recent']);

    const interruptedAgain = new LocalStore(file, { betaInviteCode: invite });
    assert.deepEqual(interruptedAgain.dueDeliveries(), []);
    interruptedAgain.ingest(reading('17', true, 1, 'fitness02'));
    assert.equal(interruptedAgain.state.outbox[0].status, 'cancelled');
    assert.deepEqual(interruptedAgain.dueDeliveries(), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a session already ended in Istanbul never becomes a Telegram delivery', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-ended-session-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'), { betaInviteCode: 'test_invite_code_2026' });
    store.setFacilityCatalog([{ id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' }]);
    assert.equal(store.approveBetaChat(123, 'test_invite_code_2026'), 'approved');
    store.subscribe(123, '17');
    const pastDay = new Date(Date.now() - 48 * 60 * 60_000).toISOString().slice(0, 10);
    const futureDay = new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10);
    const at = [120_000, 60_000, 0].map(ms => new Date(Date.now() - ms).toISOString());
    const snapshot = (free, id, observedAt) => ({
      schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: observedAt, fresh: true, refresh_id: id,
      facility: { id: '17', label: 'Fitness' }, view: { type: 'day', date: pastDay },
      slots: [{ date: pastDay, start: '11:00', end: '12:45', free }]
    });
    store.ingest(snapshot(0, 'ended001', at[0]));
    store.ingest(snapshot(1, 'ended002', at[1]));
    assert.equal(store.ingest(snapshot(1, 'ended003', at[2])).length, 1);
    assert.equal(store.status().queued, 0);

    store.state.outbox.push(
      { id: 'past', status: 'queued', nextAt: Date.now(), event: {
        date: pastDay, start: '11:00', end: '12:45', observedAt: new Date().toISOString() } },
      { id: 'future', status: 'queued', nextAt: Date.now(), event: {
        date: futureDay, start: '11:00', end: '12:45', observedAt: new Date().toISOString() } }
    );
    assert.deepEqual(store.dueDeliveries().map(item => item.id), ['future']);
    assert.equal(store.state.outbox.find(item => item.id === 'past').reason, 'session_ended');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a fresh vacancy remains eligible and old queued alerts expire during ordinary saves', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-fresh-delivery-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'));
    const now = Date.now();
    store.state.outbox.push(
      { id: 'fresh', status: 'queued', nextAt: now, event: { observedAt: new Date(now - 60_000).toISOString() } },
      { id: 'old', status: 'queued', nextAt: now, event: { observedAt: new Date(now - 6 * 60_000).toISOString() } }
    );
    store.save();
    assert.deepEqual(store.dueDeliveries(now).map(item => item.id), ['fresh']);
    assert.equal(store.status().expired, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a newer site reading cancels deferred vacancy messages that it no longer confirms', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-revoked-vacancy-'));
  const file = join(folder, 'state.json');
  try {
    const store = new LocalStore(file);
    store.setFacilityCatalog([
      { id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' },
      { id: '21', label: 'Havuz', unit: 'Havuz Müdürlüğü' }
    ]);
    const date = '2099-10-19';
    const at = new Date(Date.now() - 20_000).toISOString();
    const event = id => ({ facility: { id, label: id === '17' ? 'Fitness' : 'Havuz' },
      date, start: '11:00', end: '12:45', free: 2, observedAt: at });
    store.state.outbox.push(
      { id: 'fitness', chatId: '123', status: 'queued', attempts: 0,
        nextAt: Date.now() + 60_000, event: event('17') },
      { id: 'pool', chatId: '123', status: 'queued', attempts: 0,
        nextAt: Date.now() + 60_000, event: event('21') }
    );
    const snapshot = (fresh, slots, id) => ({ schema: 1,
      source: 'rez-calendar-extension', state: 'ok', observed_at: new Date().toISOString(),
      fresh, ...(fresh ? { refresh_id: id } : {}),
      facility: { id: '17', label: 'Fitness' }, view: { type: 'day', date }, slots });
    const slot = free => ({ date, start: '11:00', end: '12:45', free });
    store.ingest(snapshot(false, [slot(0)]));
    assert.deepEqual(store.state.outbox.map(item => item.status), ['queued', 'queued']);
    store.ingest(snapshot(true, [slot(0)], 'newread01'));
    assert.deepEqual(store.state.outbox.map(item => item.status), ['cancelled', 'queued']);
    assert.deepEqual(store.dueDeliveries(Date.now() + 60_000).map(item => item.id), ['pool']);
    assert.equal(store.state.outbox[0].reason, 'availability_no_longer_confirmed');
    assert.equal(store.state.outbox[0].event, undefined);
    assert.equal(store.status().failed, 0);
    assert.equal(store.status().expired, 0);

    const restored = new LocalStore(file);
    assert.deepEqual(restored.state.outbox.map(item => item.status), ['cancelled', 'queued']);
    restored.ingest({ schema: 1, source: 'rez-calendar-extension',
      state: 'calendar_unavailable', observed_at: new Date().toISOString() });
    assert.deepEqual(restored.state.outbox.map(item => item.status), ['cancelled', 'cancelled']);
    assert.deepEqual(restored.dueDeliveries(Date.now() + 60_000), []);
    assert.equal(restored.state.outbox[1].reason, 'calendar_unverified');
    assert.equal(restored.state.outbox[1].event, undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a newer reading that still confirms the same vacancy keeps its queued message', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rez-confirmed-vacancy-'));
  try {
    const store = new LocalStore(join(folder, 'state.json'));
    store.setFacilityCatalog([{ id: '17', label: 'Fitness', unit: 'Spor Müdürlüğü' }]);
    const date = '2099-10-19';
    store.state.outbox.push({ id: 'vacancy', chatId: '123', status: 'queued',
      attempts: 0, nextAt: Date.now(), event: { facility: { id: '17', label: 'Fitness' },
        date, start: '11:00', end: '12:45', free: 2,
        observedAt: new Date(Date.now() - 20_000).toISOString() } });
    store.ingest({ schema: 1, source: 'rez-calendar-extension', state: 'ok',
      observed_at: new Date().toISOString(), fresh: true, refresh_id: 'newread02',
      facility: { id: '17', label: 'Fitness' }, view: { type: 'day', date },
      slots: [{ date, start: '11:00', end: '12:45', free: 2 }] });
    assert.equal(store.state.outbox[0].status, 'queued');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('parser diagnostics retain only bounded calendar fields and never arbitrary strings', async()=>{
 const {sanitizeReaderDiagnostic}=await import('../src/store.mjs');
 const value=sanitizeReaderDiagnostic({schema:1,facilityId:'17',date:'2026-10-28',dates:['2026-10-28','SECRET'],domDates:['2026-10-29'],token:'SECRET',events:[{start:'SECRET',end:'2026-10-28T09:30:00+0300',free:'5',password:'SECRET'}]});
 assert.equal(value.events[0].start,'invalid_format');assert.deepEqual(value.dates,['2026-10-28']);assert.equal(JSON.stringify(value).includes('SECRET'),false);assert.equal(value.events[0].free,5);
 assert.equal(sanitizeReaderDiagnostic({schema:1,facilityId:'SECRET',date:'2026-10-28'}),null);
});

test('selections whose session or day is over are removed automatically; future and every-day ones stay',async()=>{
 const {LocalStore}=await import('../src/store.mjs');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'rez-prune-'));const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_prune_invite_2026'});
 try{
  store.approveBetaChat(123,'test_prune_invite_2026');store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'}]);
  const now=Date.parse('2026-10-30T14:30:00Z');// 17.30 Istanbul
  store.subscribe(123,'17',{date:'2026-10-29',notifyAvailable:true});
  store.subscribe(123,'17',{date:'2026-10-30',startAfter:'16:00',endBefore:'17:30',exactTime:true,notifyAvailable:true});
  store.subscribe(123,'17',{date:'2026-10-30',startAfter:'18:00',endBefore:'19:40',exactTime:true,notifyAvailable:true});
  store.subscribe(123,'17',{date:'2026-10-30',notifyAvailable:true});
  store.subscribe(123,'17',{date:'2026-10-31',startAfter:'08:00',endBefore:'09:30',exactTime:true,notifyAvailable:true});
  store.subscribe(123,'17',{startAfter:'15:00'});
  assert.equal(store.pruneEndedSelections(now),2);
  assert.deepEqual(store.filtersFor(123,'17').map(x=>`${x.date||'*'} ${x.startAfter||''}`).sort(),['* 15:00','2026-10-30 ','2026-10-30 18:00','2026-10-31 08:00']);
  assert.equal(store.pruneEndedSelections(now),0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('Sunday-evening readings of the new week build each day’s session list, which only grows; other times learn nothing',async()=>{
 const {LocalStore}=await import('../src/store.mjs');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'rez-week-'));const store=new LocalStore(join(folder,'state.json'),{betaInviteCode:'test_week_invite_2026'});
 try{
  const obs=(at,date,times)=>({state:'ok',fresh:true,observedAt:at,facility:{id:'17'},date,slots:times.map(([start,end])=>({date,start,end,free:5}))});
  // 2026-11-01 is a Sunday; 18:05Z is 21:05 in Istanbul.
  assert.equal(store.learnPublishedWeek(obs('2026-11-01T18:05:00Z','2026-11-07',[['08:00','09:40'],['10:00','11:40'],['16:00','17:40']])),true);
  assert.equal(store.learnPublishedWeek(obs('2026-11-01T18:09:00Z','2026-11-07',[['16:00','17:40']])),false,'a filled session stays known');
  store.learnPublishedWeek(obs('2026-11-01T18:12:00Z','2026-11-07',[['12:00','13:40']]));
  assert.deepEqual(store.state.sessionCatalog['17|2026-11-07'].sessions.map(s=>s.start),['08:00','10:00','12:00','16:00']);
  assert.equal(store.state.sessionCatalog['17|2026-11-07'].source,'weekly-publication');
  assert.equal(store.learnPublishedWeek(obs('2026-11-01T16:29:00Z','2026-11-08',[['09:00','10:45']])),false,'before 19:30');
  assert.equal(store.learnPublishedWeek(obs('2026-11-01T16:35:00Z','2026-11-08',[['09:00','10:45']])),true,'19:35 already counts');
  assert.equal(store.learnPublishedWeek(obs('2026-11-01T18:05:00Z','2026-11-01',[['19:00','20:45']])),false,'not the same Sunday');
  assert.equal(store.learnPublishedWeek(obs('2026-11-03T18:05:00Z','2026-11-07',[['14:00','15:40']])),false,'not on a Tuesday');
  assert.equal(store.learnPublishedWeek({...obs('2026-11-01T18:05:00Z','2026-11-08',[['09:00','10:45']]),fresh:false}),false,'only fresh readings');
  store.state.sessionCatalog['17|2026-10-01']={source:'weekly-publication',sessions:[]};
  store.pruneEndedSelections(Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(store.state.sessionCatalog['17|2026-10-01'],undefined);assert.ok(store.state.sessionCatalog['17|2026-11-07']);
  assert.deepEqual(store.status().sessionCatalog,{},'weekly lists are not sent to the extension parser');
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('the new week is learned internally without creating a user broadcast',async()=>{
 const {LocalStore}=await import('../src/store.mjs');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=mkdtempSync(join(tmpdir(),'rez-weekly-notice-'));const store=new LocalStore(join(folder,'state.json'),{accessMode:'public'});
 try{
  for(const id of [101,102,103])store.admitChat(id);store.setWeekNotice(103,false);
  const obs=(id,date,times,at='2026-11-01T17:40:00Z')=>({state:'ok',fresh:true,observedAt:at,facility:{id},date,slots:times.map(([start,end])=>({date,start,end,free:4}))});
  assert.equal(store.learnPublishedWeek(obs('17','2026-11-02',[])),false,'an empty read before publication');
  assert.equal(store.state.sessionCatalog?.['17|2026-11-02'],undefined);
  store.learnPublishedWeek(obs('17','2026-11-02',[['08:00','09:30']]));store.learnPublishedWeek(obs('21','2026-11-03',[['08:00','09:30']]));
  assert.equal(store.state.broadcast,undefined);
  assert.equal(store.state.weekAnnouncements?.['2026-11-02'],undefined,'two facilities are not yet a published week');
  store.learnPublishedWeek(obs('3','2026-11-08',[['10:00','11:00']]));
  assert.equal(store.state.weekAnnouncements['2026-11-02'],'2026-11-01T17:40:00Z');
  assert.equal(store.state.broadcast,undefined,'publication never queues a public message');
  store.learnPublishedWeek(obs('5','2026-11-04',[['12:00','13:00']]));
  assert.equal(store.state.broadcast,undefined);
  assert.deepEqual(store.state.sessionCatalog['5|2026-11-04'].sessions,[{start:'12:00',end:'13:00'}]);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('restart discards legacy public broadcasts while preserving saved selections and Telegram offset',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-quiet-restart-')),file=join(folder,'state.json');
 try{
  const store=new LocalStore(file,{accessMode:'public'});store.admitChat(101);store.setLanguage(101,'en');
  store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'}]);
  store.subscribe(101,'17',{date:'2026-11-09',startAfter:'16:00',endBefore:'17:40',exactTime:true,notifyAvailable:true});
  store.state.telegramOffset=456;store.state.broadcast={kind:'week',pending:['101'],createdAt:new Date().toISOString()};store.save();
  const selections=structuredClone(store.state.subscriptions);
  const reopened=new LocalStore(file,{accessMode:'public'});
  assert.equal(reopened.state.broadcast,null);assert.deepEqual(reopened.state.subscriptions,selections);
  assert.equal(reopened.state.telegramOffset,456);assert.equal(reopened.languageFor(101),'en');
  reopened.setWeekNotice(101,true);assert.equal(reopened.weekNoticeOn(101),false);
  assert.equal(new LocalStore(file,{accessMode:'public'}).state.broadcast,null);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('midweek fresh calendar changes extend published dated hours, persist and never move an exact-time preference',t=>{
 const at=Date.parse('2026-11-03T10:00:00Z');t.mock.timers.enable({apis:['Date'],now:at});
 const folder=mkdtempSync(join(tmpdir(),'rez-midweek-')),file=join(folder,'state.json');
 try{
  const store=new LocalStore(file,{accessMode:'public'});store.setFacilityCatalog([{id:'17',label:'Baraka Fitness',unit:'Spor Müdürlüğü'}]);store.admitChat(123);
  const date='2026-11-07';
  store.learnPublishedWeek({state:'ok',fresh:true,observedAt:'2026-11-01T18:05:00Z',facility:{id:'17'},date,slots:[{date,start:'18:00',end:'19:00',free:5}]});
  store.subscribe(123,'17',{date,startAfter:'18:00',endBefore:'19:00',notifyAvailable:true,exactTime:true});
  const snap=(slots,fresh=true)=>({schema:1,source:'rez-calendar-extension',state:'ok',facility:{id:'17',label:'Baraka Fitness'},view:{type:'day',date},fresh,observed_at:new Date().toISOString(),...(fresh?{refresh_id:`midweek-change-${Date.now()}`} : {}),slots});
  store.ingest(snap([{date,start:'18:30',end:'20:00',free:2}]));
  assert.deepEqual(store.state.sessionCatalog[`17|${date}`].sessions.map(s=>s.start),['18:00','18:30']);
  assert.equal(store.state.sessionCatalog[`17|${date}`].source,'weekly-publication');assert.equal(store.state.broadcast,undefined);
  assert.deepEqual(store.filtersFor(123,'17').map(s=>[s.startAfter,s.endBefore,s.exactTime]),[['18:00','19:00',true]]);assert.equal(store.status().queued,0);
  t.mock.timers.tick(1000);store.ingest(snap([]));
  assert.equal(store.state.sessionCatalog[`17|${date}`].sessions.length,2,'a holiday/full/omitted list cannot prove that hours were cancelled');
  assert.equal(store.status().queued,0,'empty fresh data must not manufacture a vacancy');
  t.mock.timers.tick(1000);store.ingest(snap([{date,start:'22:00',end:'23:00',free:4}],false));
  assert.equal(store.state.sessionCatalog[`17|${date}`].sessions.length,2,'passive data cannot change the learned timetable');
  const reloaded=new LocalStore(file,{accessMode:'public'});assert.deepEqual(reloaded.state.sessionCatalog[`17|${date}`].sessions.map(s=>s.start),['18:00','18:30']);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('stale or wrong-day changes cannot amend a dated catalog; an explicit replacement still supersedes old hours',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rez-catalog-update-'));
 try{
  const store=new LocalStore(join(folder,'state.json'));store.setFacilityCatalog([{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]);const date='2026-11-07';
  store.setSessionCatalog('17',date,[{start:'18:00',end:'19:00'}],'2026-11-03T10:00:00Z');
  const obs={state:'ok',fresh:true,facility:{id:'17'},date,observedAt:'2026-11-03T09:59:59Z',slots:[{date,start:'19:00',end:'20:00',free:1}]};
  assert.equal(store.learnCalendarChanges(obs),false);
  assert.equal(store.learnCalendarChanges({...obs,observedAt:'invalid'}),false);
  assert.equal(store.learnCalendarChanges({...obs,observedAt:'2026-11-03T10:01:00Z',slots:[{date:'2026-11-08',start:'19:00',end:'20:00'}]}),false);
  assert.equal(store.learnCalendarChanges({...obs,observedAt:'2026-11-03T10:01:00Z'}),true);
  store.setSessionCatalog('17',date,[{start:'20:00',end:'21:00'}],'2026-11-03T10:02:00Z');
  assert.deepEqual(store.state.sessionCatalog[`17|${date}`].sessions,[{start:'20:00',end:'21:00'}]);
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test('weekly learning cannot erase an independent parser proof or extend its freshness',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-01T19:15:00Z')});
 const folder=mkdtempSync(join(tmpdir(),'rez-official-proof-'));try{
  const s=new LocalStore(join(folder,'state.json'));s.setFacilityCatalog([{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]);const date='2026-11-04',verifiedAt='2026-11-01T19:13:46Z';
  s.setSessionCatalog('17',date,[{start:'08:00',end:'09:30'}],verifiedAt);
  s.learnPublishedWeek({state:'ok',fresh:true,facility:{id:'17'},date,observedAt:'2026-11-01T19:15:00Z',slots:[{date,start:'08:00',end:'09:30',free:45},{date,start:'10:00',end:'11:30',free:30}]});
  assert.equal(s.state.sessionCatalog['17|'+date].source,'weekly-publication');assert.equal(s.state.sessionCatalog['17|'+date].sessions.length,2);
  const proof=s.status().sessionCatalog['17|'+date];assert.equal(proof.source,'official-booking-form');assert.equal(proof.verifiedAt,verifiedAt);assert.deepEqual(proof.sessions,[{start:'08:00',end:'09:30'}]);
  s.save();const loaded=new LocalStore(s.file);assert.deepEqual(loaded.status().sessionCatalog['17|'+date],proof);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
