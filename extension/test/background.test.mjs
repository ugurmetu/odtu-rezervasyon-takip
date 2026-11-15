import '../scheduler.js';
import '../parallel-reader.js';
import '../single-reader.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const origin = 'https://rez.metu.edu.tr';
const verifiedEvidence = { ok: true, date: '2026-10-18', facilityId: '17',
  refreshId: '123e4567-e89b-42d3-a456-426614174000', events: [] };

function evidenceFor(snapshot) {
  if (snapshot?.snapshots) return { ...verifiedEvidence, facilityId:snapshot.facility.id,
    viewType:'week', dates:[...snapshot.snapshots.map(item=>item.view.date),...(snapshot.rejectedDates||[])] };
  if (snapshot?.state === 'login_required') return { ok: false, reason: 'login_required' };
  if (snapshot?.state === 'calendar_unavailable' && snapshot.detail) {
    return { ok: false, reason: snapshot.detail };
  }
  return verifiedEvidence;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('background did not reach the expected state');
}

function harness({ result, resultSequence = null, paused = false, pendingCapture = null,
  pendingIngest = null, initialAlarmPeriod = 0.5, localHealthAvailable = true,
  initialStorage = {}, pendingHealth = null, pendingTabLookup = null,
  parseFailureOnce = false, configExtra = {}, tabsList = null, recovery = undefined, perTabResults = null, directReader = null, directEvidence = null, budgetWait = null, healPage = null, ingestReply = {} } = {}) {
  let clock = Date.parse('2026-10-18T12:00:00Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const storage = { paused, lastAttemptAt: 0, targetTabId: null, ...initialStorage };
  const calls = { capture: 0, repair: 0, parse: 0, tabLookup: 0, health: 0, ingest: 0,
    ingestPayloads: [], ingestSignals: [], alarmCreates: [], injections: [], tabUpdates: [], budgetWaits: [] };
  let lastSelectedResult = result;
  const tabResults=new Map();
  let receiverAvailable = localHealthAvailable;
  let alarm = initialAlarmPeriod === null ? null
    : { name: 'rez-calendar-capture', periodInMinutes: initialAlarmPeriod };
  let onAlarm;
  let onInstalled;
  let onMessage;
  const chrome = {
    alarms: {
      get: async () => alarm,
      create: async (name, options) => {
        alarm = { name, ...options };
        calls.alarmCreates.push({ name, ...options });
      },
      onAlarm: { addListener(listener) { onAlarm = listener; } }
    },
    runtime: {
      getURL: () => 'chrome-extension://pilot/local-config.json',
      onInstalled: { addListener(listener) { onInstalled = listener; } },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    storage: { local: {
      get: async () => ({ ...storage }),
      set: async (value) => { Object.assign(storage, value); }
    } },
    tabs: {
      get:async id=>({id,url:tabsList?.find(t=>t.id===id)?.url||`${origin}/view/home.jsf`}),
      query: async () => {
        calls.tabLookup += 1;
        if (pendingTabLookup) await pendingTabLookup.promise;
        return tabsList || [{ id: 7, url: `${origin}/view/home.jsf`, lastAccessed: 1 }];
      },
      update: async (id, options) => { calls.tabUpdates.push([id, options]); return { id }; },
      sendMessage: async (_id, message) => {
        assert.equal(message.type, 'rez:parse');
        calls.parse += 1;
        if (parseFailureOnce && calls.parse === 1) throw new Error('Receiving end does not exist');
        return tabResults.get(_id)||lastSelectedResult;
      }
    },
    scripting: {
      executeScript: async (injection) => {
        if(healPage&&injection.func===recovery?.inspectPage)return [{frameId:0,result:healPage}];
        if (injection.world === 'ISOLATED') {
          calls.repair += 1;
          calls.injections.push(injection);
          return [{ frameId: 0, result: null }];
        }
        calls.capture += 1;
        calls.injections.push(injection);
        const selected = perTabResults?.[injection.target.tabId] || (pendingCapture ? await pendingCapture.promise
          : resultSequence ? resultSequence[Math.min(calls.capture - 1, resultSequence.length - 1)]
            : result);
        tabResults.set(injection.target.tabId,selected);
        lastSelectedResult = selected;
        if (injection.func && directEvidence) return [{ frameId: 0, result: { done: true, result: directEvidence(injection, evidenceFor(selected), clock) } }];
        return [{ frameId: 0, result: evidenceFor(selected) }];
      }
    }
  };
  const fetch = async (url, options = {}) => {
    if (String(url).startsWith('chrome-extension:')) {
      return { ok: true, json: async () => ({ ingestUrl: 'http://127.0.0.1:8765/ingest',
        key: 'a'.repeat(64), ...configExtra }) };
    }
    if (String(url).endsWith('/health')) {
      calls.health += 1;
      if (pendingHealth) await pendingHealth.promise;
      if (!receiverAvailable) throw new Error('local receiver unavailable');
      return { ok: true, json: async () => ({ ok: true }) };
    }
    calls.ingest += 1;
    calls.ingestPayloads.push(JSON.parse(options.body));
    calls.ingestSignals.push(options.signal);
    return pendingIngest && calls.ingest === 1 ? pendingIngest.promise : { ok: true, json:async()=>typeof ingestReply==='function'?ingestReply(JSON.parse(options.body)):ingestReply };
  };
  runInNewContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), {
    chrome, fetch, Date: ClockDate, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto,
    RezScheduler: globalThis.RezScheduler,
    RezParallel: budgetWait?{...globalThis.RezParallel,create:options=>globalThis.RezParallel.create({...options,sleep:async ms=>{calls.budgetWaits.push(ms);clock+=ms;await budgetWait(ms,storage,configExtra);}})}:globalThis.RezParallel,
    RezSingle: globalThis.RezSingle,
    RezRecovery: recovery,
    ...(directReader ? { rezMainPage: directReader } : {})
  });
  return {
    storage, calls,
    alarm() { onAlarm({ name: 'rez-calendar-capture' }); },
    install(reason) { return onInstalled({ reason }); },
    pause(value) {
      return new Promise((resolve) => {
        assert.equal(onMessage({ type: 'rez:set-paused', paused: value }, {}, resolve), true);
      });
    },
    advance(ms) { clock += ms; },
    setHealthAvailable(value) { receiverAvailable = value; }
  };
}

test('a lost content listener is repaired from the same verified site response without a second site request', async () => {
  const pilot = harness({ result: fresh, parseFailureOnce: true });
  pilot.alarm();
  await until(() => pilot.storage.lastStatus?.detail === 'local_sent');
  assert.equal(pilot.calls.capture, 1);
  assert.equal(pilot.calls.repair, 1);
  assert.equal(pilot.calls.parse, 2);
  assert.deepEqual(Array.from(pilot.calls.injections[1].files), ['parser.js', 'content.js']);
  assert.equal(pilot.calls.ingestPayloads[0].state, 'ok');
});

const fresh = { schema: 1, source: 'rez-calendar-extension',
  observed_at: '2026-10-18T12:00:00Z', fresh: true, state: 'ok',
  facility: { id: '17', label: 'Baraka' }, view: { type: 'day', date: '2026-10-18' },
  refresh_id: '123e4567-e89b-42d3-a456-426614174000', slots: [] };

test('a manual stop during capture prevents the old snapshot from reaching the local server', async () => {
  const pendingCapture = deferred();
  const pilot = harness({ pendingCapture });
  pilot.alarm();
  await until(() => pilot.calls.capture === 1);
  const stopped = await pilot.pause(true);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.paused, true);
  pendingCapture.resolve(fresh);
  await until(() => Boolean(pilot.storage.lastCaptureEndAt));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.ingest, 1);
  assert.equal(pilot.calls.ingestPayloads[0].state, 'paused');
  assert.equal(pilot.storage.pauseSource, 'manual_stop');
  assert.equal(pilot.storage.pausedReason, null);
});

test('a stop and restart during capture cannot send the old snapshot', async () => {
  const pendingCapture = deferred();
  const pilot = harness({ pendingCapture });
  pilot.alarm();
  await until(() => pilot.calls.capture === 1);
  await pilot.pause(true);
  await pilot.pause(false);
  pendingCapture.resolve(fresh);
  await until(() => Boolean(pilot.storage.lastCaptureEndAt));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.storage.paused, false);
  assert.equal(pilot.calls.ingest, 1);
  assert.equal(pilot.calls.ingestPayloads[0].state, 'paused');
  assert.equal(pilot.storage.pauseSource, 'manual_start');
});

test('manual Start clears the prior run result while its first capture is pending', async () => {
  const pendingCapture = deferred();
  const pilot = harness({ paused: true, pendingCapture });
  pilot.storage.lastStatus = { state: 'ok', detail: 'local_sent',
    at: '2026-10-18T11:59:55Z', fresh: true };
  await pilot.pause(false);
  await until(() => pilot.calls.capture === 1);
  assert.equal(pilot.storage.paused, false);
  assert.equal(pilot.storage.lastStatus, null);
  pendingCapture.resolve(fresh);
  await until(() => pilot.storage.lastStatus?.detail === 'local_sent');
  assert.equal(pilot.calls.ingest, 1);
});

test('Stop aborts a pending ingest and ignores a late successful response', async () => {
  const pendingIngest = deferred();
  const pilot = harness({ result: fresh, pendingIngest });
  pilot.alarm();
  await until(() => pilot.calls.ingest === 1);
  assert.equal(pilot.calls.ingestSignals[0].aborted, false);
  await pilot.pause(true);
  assert.equal(pilot.calls.ingestSignals[0].aborted, true);
  pendingIngest.resolve({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.ingestPayloads[1].state, 'paused');
  assert.equal(pilot.storage.lastStatus.state, 'paused');
});

test('Stop then Start leaves an old in-flight ingest unable to replace the pending state', async () => {
  const pendingIngest = deferred();
  const pilot = harness({ result: fresh, pendingIngest });
  pilot.alarm();
  await until(() => pilot.calls.ingest === 1);
  await pilot.pause(true);
  await pilot.pause(false);
  assert.equal(pilot.storage.lastStatus, null);
  pendingIngest.resolve({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.storage.lastStatus, null);
  assert.equal(pilot.calls.ingestPayloads[1].state, 'paused');
});

test('a site block pauses locally and sends a nonfresh status to clear bot coverage', async () => {
  const blocked = { ...fresh, state: 'calendar_unavailable', fresh: false,
    detail: 'site_rate_limited', slots: [] };
  const pilot = harness({ result: blocked });
  pilot.alarm();
  await until(() => Boolean(pilot.storage.lastStatus));
  assert.equal(pilot.storage.paused, true);
  assert.equal(pilot.storage.pausedReason, 'site_rate_limited');
  assert.equal(pilot.storage.pauseSource, 'site_rate_limited');
  assert.equal(pilot.storage.lastStatus.detail, 'site_rate_limited');
  assert.equal(pilot.calls.ingest, 1);
  assert.equal(pilot.calls.ingestPayloads[0].state, 'calendar_unavailable');
  assert.equal(pilot.calls.ingestPayloads[0].fresh, false);
  assert.equal(pilot.calls.ingestPayloads[0].detail, 'site_rate_limited');
});

test('local receiver outage prevents site capture and resumes automatically when healthy', async () => {
  const pilot = harness({ result: fresh, localHealthAvailable: false });
  pilot.alarm();
  await until(() => pilot.storage.lastStatus?.detail === 'local_server_unavailable');
  assert.equal(pilot.calls.health, 1);
  assert.equal(pilot.calls.capture, 0);
  assert.equal(pilot.calls.ingest, 0);
  assert.equal(pilot.storage.paused, false);

  pilot.advance(30_000);
  pilot.alarm();
  await until(() => pilot.calls.health === 2
    && pilot.storage.lastStatus?.at === '2026-10-18T12:00:30.000Z');
  assert.equal(pilot.calls.capture, 0);

  pilot.setHealthAvailable(true);
  pilot.advance(30_000);
  pilot.alarm();
  await until(() => pilot.storage.lastStatus?.detail === 'local_sent');
  assert.equal(pilot.calls.capture, 1);
  assert.equal(pilot.storage.lastStatus?.detail, 'local_sent');
});

test('an unexpected page rate gate preserves coverage without bypassing the persistent 60-second limit', async () => {
  const localGate = { ...fresh, state: 'calendar_unavailable', fresh: false,
    detail: 'rate_limited', slots: [] };
  const pilot = harness({ resultSequence: [fresh, localGate, fresh] });
  pilot.alarm();
  await until(() => pilot.calls.ingest === 1 && Boolean(pilot.storage.lastStatus));
  const verifiedStatus = pilot.storage.lastStatus;
  const firstIngestAt = pilot.storage.lastIngestAt;
  await new Promise((resolve) => setImmediate(resolve));

  pilot.advance(60_000);
  pilot.alarm();
  await until(() => pilot.calls.capture === 2
    && pilot.storage.lastCaptureEndAt === '2026-10-18T12:01:00.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.capture, 2);
  assert.equal(pilot.calls.ingest, 1);
  assert.equal(pilot.storage.lastStatus, verifiedStatus);
  assert.equal(pilot.storage.lastIngestAt, firstIngestAt);
  assert.equal(pilot.storage.paused, false);

  pilot.advance(30_000);
  pilot.alarm();
  await until(() => pilot.storage.lastAlarmAt === '2026-10-18T12:01:30.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.capture, 2);
  assert.equal(pilot.calls.ingest, 1);

  pilot.advance(30_000);
  pilot.alarm();
  await until(() => pilot.calls.ingest === 2 && pilot.storage.lastStatus !== verifiedStatus);
  assert.equal(pilot.calls.capture, 3);
  assert.equal(pilot.storage.lastStatus.detail, 'local_sent');
});

test('the 60-second gate survives a service-worker restart and manual Stop/Start', async () => {
  const first = harness({ result: fresh });
  first.alarm();
  await until(() => first.calls.ingest === 1 && first.storage.lastStatus?.detail === 'local_sent');
  const carried = structuredClone(first.storage);
  const restarted = harness({ result: fresh, initialStorage: carried });
  restarted.alarm();
  await until(() => Boolean(restarted.storage.lastAlarmAt));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.calls.capture, 0);

  await restarted.pause(true);
  await restarted.pause(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.calls.capture, 0);
  restarted.advance(59_999);
  restarted.alarm();
  await until(() => restarted.storage.lastAlarmAt === '2026-10-18T12:00:59.999Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.calls.capture, 0);
  restarted.advance(1);
  restarted.alarm();
  await until(() => restarted.calls.capture === 1);
  assert.equal(restarted.calls.injections.length, 1);
});

test('a slow local health preflight cannot shorten the gap between site requests', async () => {
  const pendingHealth = deferred();
  const pilot = harness({ result: fresh, pendingHealth });
  pilot.alarm();
  await until(() => pilot.calls.health === 1);
  pilot.advance(3_000);
  pendingHealth.resolve();
  await until(() => pilot.calls.capture === 1 && pilot.calls.ingest === 1);
  assert.equal(pilot.storage.lastAttemptAt, Date.parse('2026-10-18T12:00:03Z'));

  pilot.advance(57_000);
  pilot.alarm();
  await until(() => pilot.storage.lastAlarmAt === '2026-10-18T12:01:00.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.capture, 1);

  pilot.advance(3_000);
  pilot.alarm();
  await until(() => pilot.calls.capture === 2);
  assert.equal(pilot.storage.lastAttemptAt, Date.parse('2026-10-18T12:01:03Z'));
});

test('a slow tab lookup cannot shorten the gap between site requests', async () => {
  const pendingTabLookup = deferred();
  const pilot = harness({ result: fresh, pendingTabLookup });
  pilot.alarm();
  await until(() => pilot.calls.tabLookup === 1);
  pilot.advance(4_000);
  pendingTabLookup.resolve();
  await until(() => pilot.calls.capture === 1 && pilot.calls.ingest === 1);
  assert.equal(pilot.storage.lastAttemptAt, Date.parse('2026-10-18T12:00:04Z'));

  pilot.advance(56_000);
  pilot.alarm();
  await until(() => pilot.storage.lastAlarmAt === '2026-10-18T12:01:00.000Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.capture, 1);

  pilot.advance(4_000);
  pilot.alarm();
  await until(() => pilot.calls.capture === 2);
  assert.equal(pilot.storage.lastAttemptAt, Date.parse('2026-10-18T12:01:04Z'));
});

test('alarm, attempt, capture and ingest timestamps distinguish throttled ticks', async () => {
  const pilot = harness({ result: fresh });
  pilot.alarm();
  await until(() => Boolean(pilot.storage.lastStatus));
  const firstAlarmAt = pilot.storage.lastAlarmAt;
  const firstAttemptAt = pilot.storage.lastAttemptAt;
  const firstCaptureEndAt = pilot.storage.lastCaptureEndAt;
  assert.equal(typeof firstAttemptAt, 'number');
  assert.equal(typeof firstCaptureEndAt, 'string');
  assert.equal(typeof pilot.storage.lastIngestAt, 'string');
  assert.equal(pilot.calls.capture, 1);
  assert.equal(pilot.calls.ingest, 1);

  pilot.advance(10_000);
  pilot.alarm();
  await until(() => pilot.storage.lastAlarmAt !== firstAlarmAt);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.storage.lastAttemptAt, firstAttemptAt);
  assert.equal(pilot.storage.lastCaptureEndAt, firstCaptureEndAt);
  assert.equal(pilot.calls.capture, 1);
  assert.equal(pilot.calls.ingest, 1);
});

test('an early alarm retries at the next 30-second wakeup without a second site request inside 60 seconds', async () => {
  const pilot = harness({ result: fresh });
  pilot.alarm();
  await until(() => pilot.calls.ingest === 1);
  const firstAttemptAt = pilot.storage.lastAttemptAt;

  pilot.advance(59_900);
  pilot.alarm();
  await until(() => pilot.storage.lastAlarmAt === '2026-10-18T12:00:59.900Z');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pilot.calls.capture, 1);
  assert.equal(pilot.storage.lastAttemptAt, firstAttemptAt);

  pilot.advance(30_000);
  pilot.alarm();
  await until(() => pilot.calls.ingest === 2);
  assert.equal(pilot.calls.capture, 2);
  assert.equal(pilot.storage.lastAttemptAt - firstAttemptAt, 89_900);
});

test('an existing one-minute alarm is upgraded to 30 seconds and is not recreated on manual actions', async () => {
  const pilot = harness({ paused: true, initialAlarmPeriod: 1 });
  await until(() => pilot.calls.alarmCreates.length === 1);
  assert.equal(pilot.calls.alarmCreates[0].name, 'rez-calendar-capture');
  assert.equal(pilot.calls.alarmCreates[0].periodInMinutes, 0.5);
  await pilot.pause(true);
  assert.equal(pilot.calls.alarmCreates.length, 1);
});

test('a missing alarm is restored at the 30-second period', async () => {
  const pilot = harness({ paused: true, initialAlarmPeriod: null });
  await until(() => pilot.calls.alarmCreates.length === 1);
  assert.equal(pilot.calls.alarmCreates[0].periodInMinutes, 0.5);
});

test('update and manual actions record fixed pause sources without changing pausedReason behavior', async () => {
  const pilot = harness();
  await pilot.install('update');
  assert.equal(pilot.storage.paused, true);
  assert.equal(pilot.storage.pausedReason, null);
  assert.equal(pilot.storage.pauseSource, 'update');
  assert.equal(typeof pilot.storage.pauseChangedAt, 'string');

  pilot.storage.lastAttemptAt = Date.parse('2026-10-18T12:00:00Z');
  await pilot.pause(false);
  assert.equal(pilot.storage.paused, false);
  assert.equal(pilot.storage.pauseSource, 'manual_start');
  await pilot.pause(true);
  assert.equal(pilot.storage.paused, true);
  assert.equal(pilot.storage.pausedReason, null);
  assert.equal(pilot.storage.pauseSource, 'manual_stop');
});

test('two configured weekly tabs alternate behind one global request gate and post only requested dates', async () => {
  const dates=['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
  const week = id => {
    const snapshots=dates.map(date=>({...fresh,facility:{id,label:'Fitness'},view:{type:'day',date}}));
    return {...snapshots[0],snapshots};
  };
  const pilot=harness({resultSequence:[week('17'),week('21')],
    configExtra:{watchTabs:[{tabId:7,facilityId:'17'},{tabId:8,facilityId:'21'}],watchDates:dates.slice(2,5)},
    tabsList:[7,8,9].map(id=>({id,url:`${origin}/view/home.jsf`}))});
  pilot.alarm(); await until(()=>pilot.calls.ingest===1);
  assert.equal(pilot.calls.injections[0].target.tabId,7);
  assert.equal(pilot.calls.ingestPayloads[0].snapshots.length,3);
  assert.equal(pilot.calls.ingestPayloads[0].snapshots[0].view.date,'2026-10-28');
  pilot.advance(59_000); pilot.alarm(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pilot.calls.capture,1);
  pilot.advance(1_000); pilot.alarm(); await until(()=>pilot.calls.ingest===2);
  assert.equal(pilot.calls.injections[1].target.tabId,8);
  assert.equal(pilot.calls.ingestPayloads[1].facility.id,'21');
});

test('a dated watch stops after its last day without requesting the site again', async () => {
  const pilot=harness({result:fresh,configExtra:{watchDates:['2026-10-17']}});
  pilot.alarm(); await until(()=>pilot.storage.paused===true);
  assert.equal(pilot.storage.pauseSource,'watch_complete');
  assert.equal(pilot.calls.capture,0);
});

test('managed salons keep their turn across early alarm wakeups and both get fresh reads',async()=>{
  const dates=['2026-10-28','2026-10-29','2026-10-30'];
  const week=id=>{const snapshots=dates.map(date=>({...fresh,facility:{id,label:'Fitness'},view:{type:'day',date}}));
    return {...snapshots[0],snapshots};};
  const pilot=harness({resultSequence:[week('17'),week('21'),week('17')],
    configExtra:{autoManage:true,watchFacilities:['17','21'],watchDates:dates},
    recovery:{ensureManagedTab:async(_chrome,_config,id)=>({id:Number(id)}),ensureReady:async()=>({phase:'ready'})}});
  pilot.alarm();await until(()=>pilot.storage.lastStatus?.detail==='local_sent');
  assert.equal(pilot.storage.watchCursor,1);
  pilot.advance(30_000);pilot.alarm();await until(()=>pilot.calls.health===2);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pilot.calls.capture,1);assert.equal(pilot.storage.watchCursor,1);
  pilot.advance(30_000);pilot.alarm();await until(()=>pilot.calls.capture===2);
  await until(()=>pilot.storage.lastStatus?.at==='2026-10-18T12:01:00.000Z');
  assert.equal(pilot.calls.injections[1].target.tabId,21);
  pilot.advance(30_000);pilot.alarm();await until(()=>pilot.calls.health===4);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pilot.calls.capture,2);assert.equal(pilot.storage.watchCursor,0);
  pilot.advance(30_000);pilot.alarm();await until(()=>pilot.calls.capture===3);
  assert.equal(pilot.calls.injections[2].target.tabId,17);
});

test('fast local ticks read alternating salons every ten seconds while preserving per-salon limits',async()=>{
 const dates=['2026-10-28'];const week=id=>{const snapshots=dates.map(date=>({...fresh,facility:{id,label:'Fitness'},view:{type:'day',date}}));return {...snapshots[0],snapshots};};
 const p=harness({resultSequence:[week('17'),week('21'),week('17')],configExtra:{autoManage:true,fastWatch:true,watchFacilities:['17','21'],watchDates:dates},recovery:{ensureManagedTab:async(_c,_cfg,id)=>({id:Number(id)}),ensureReady:async()=>({phase:'ready'})}});
 p.alarm();await until(()=>p.storage.lastStatus?.detail==='local_sent');
 p.advance(5000);p.alarm();await until(()=>p.calls.health===2);await new Promise(r=>setImmediate(r));assert.equal(p.calls.capture,1);assert.equal(p.storage.watchCursor,1);
 p.advance(5000);p.alarm();await until(()=>p.storage.lastStatus?.at==='2026-10-18T12:00:10.000Z');
 p.advance(10000);p.alarm();await until(()=>p.calls.capture===3);assert.deepEqual(p.calls.injections.map(i=>i.target.tabId),[17,21,17]);
});
test('fast cadence never resumes site requests after an explicit rate-limit denial',async()=>{
 const p=harness({result:{state:'calendar_unavailable',detail:'site_rate_limited'},configExtra:{autoManage:true,fastWatch:true,watchFacilities:['17'],watchDates:['2026-10-28']},recovery:{ensureManagedTab:async()=>({id:17}),ensureReady:async()=>({phase:'ready'})}});
 p.alarm();await until(()=>p.storage.paused===true);const captures=p.calls.capture;p.advance(60000);p.alarm();await new Promise(r=>setImmediate(r));assert.equal(p.calls.capture,captures);
});

test('fitness and two tennis courts keep fair turns without increasing the global request frequency',async()=>{
 const dates=['2026-10-28'];const week=id=>{const snapshots=dates.map(date=>({...fresh,facility:{id,label:'Tesis '+id},view:{type:'day',date}}));return {...snapshots[0],snapshots};};
 const p=harness({resultSequence:['17','21','1','3','17'].map(week),configExtra:{autoManage:true,fastWatch:true,watchFacilities:['17','21','1','3'],watchDates:dates},recovery:{ensureManagedTab:async(_c,_cfg,id)=>({id:Number(id)}),ensureReady:async()=>({phase:'ready'})}});
 for(let i=0;i<5;i++){if(i)p.advance(10000);p.alarm();await until(()=>p.calls.capture===i+1);await until(()=>p.storage.lastStatus?.at===new Date(Date.parse('2026-10-18T12:00:00Z')+i*10000).toISOString());}
 assert.deepEqual(p.calls.injections.map(i=>i.target.tabId),[17,21,1,3,17]);assert.equal(p.storage.paused,false);
});
test('one tennis court still preparing does not starve the following fitness facility',async()=>{
 const date='2026-10-28',snap={...fresh,facility:{id:'17',label:'Fitness'},view:{type:'day',date}};const result={...snap,snapshots:[snap]};
 const p=harness({result,initialStorage:{watchCursor:2},configExtra:{autoManage:true,fastWatch:true,watchFacilities:['17','21','3'],watchDates:[date]},recovery:{ensureManagedTab:async(_c,_cfg,id)=>({id:Number(id)}),ensureReady:async(_c,_cfg,_t,id)=>({phase:id==='3'?'preparing':'ready'})}});
 p.alarm();await until(()=>p.storage.lastStatus?.detail==='preparing');assert.equal(p.storage.watchCursor,0);assert.equal(p.calls.capture,0);p.advance(10000);p.alarm();await until(()=>p.storage.lastStatus?.detail==='local_sent');assert.equal(p.calls.injections[0].target.tabId,17);
});

test('the all-facility reader processes a full 32-facility round without a tennis-only or two-facility whitelist',async()=>{
 const ids=Array.from({length:32},(_,i)=>String(i+1)),date='2026-10-28';
 const results=ids.map(id=>{const s={...fresh,facility:{id,label:'Tesis '+id},view:{type:'day',date}};return {...s,snapshots:[s]};});
 const p=harness({resultSequence:results,configExtra:{autoManage:true,fastWatch:true,watchFacilities:ids,watchDates:[date],scanMode:'round-robin'},recovery:{ensureManagedTab:async(_c,_cfg,id)=>({id:Number(id)}),ensureReady:async()=>({phase:'ready'})}});
 for(let i=0;i<ids.length;i++){if(i)p.advance(10000);p.alarm();await until(()=>p.storage.lastStatus?.at===new Date(Date.parse('2026-10-18T12:00:00Z')+i*10000).toISOString());}
 assert.deepEqual(p.calls.injections.map(x=>String(x.target.tabId)),ids);assert.equal(p.storage.paused,false);
});

test('parallel worker isolates four site responses and a manual stop prevents all later batches',async()=>{
 const ids=['1','2','3','4'],date='2026-10-28';const perTabResults=Object.fromEntries(ids.map(id=>{const s={...fresh,facility:{id,label:'Tesis '+id},view:{type:'day',date}};return [Number(id),{...s,snapshots:[s]}];}));
 const p=harness({perTabResults,configExtra:{autoManage:true,fastWatch:true,parallelRead:true,scanMode:'parallel',watchFacilities:ids,watchDates:[date]},recovery:{ensureManagedTab:async(_c,_cfg,id)=>({id:Number(id)}),ensureReady:async()=>({phase:'ready'})}});
 p.alarm();await until(()=>p.calls.capture===4);await until(()=>p.calls.ingestPayloads.filter(x=>x.snapshots).length===4);
 assert.deepEqual(p.calls.ingestPayloads.filter(x=>x.snapshots).map(x=>x.facility.id).sort(),ids);
 await p.pause(true);p.advance(60000);p.alarm();await new Promise(r=>setImmediate(r));assert.equal(p.calls.capture,4);
});

test('maintenance stops even a previously running parallel reader before any tab or site action',async()=>{
 const p=harness({configExtra:{autoManage:true,parallelRead:true,maintenance:true,watchFacilities:['1','2']}});
 p.alarm();await new Promise(r=>setImmediate(r));assert.equal(p.calls.capture,0);assert.equal(p.calls.tabLookup,0);assert.equal(p.calls.health,0);
});
test('the installed single-tab maintenance handshake cannot restart the old multi-tab plan',async()=>{
 const p=harness({configExtra:{autoManage:false,singleTab:true,maintenance:true,watchFacilities:[]},initialStorage:{pauseSource:'maintenance'}});
 await p.install('update');assert.equal(p.storage.paused,true);assert.equal(p.storage.pauseSource,'maintenance');
 assert.equal(p.calls.ingestPayloads[0].phase,'paused');assert.equal(p.calls.ingestPayloads[0].singleTab,true);assert.equal(p.calls.ingestPayloads[0].version,'0.8.1');assert.equal(p.calls.ingestPayloads[0].facilityIds,undefined);assert.equal(p.calls.capture,0);
});
test('a ready single-tab plan recovers from maintenance automatically but respects a deliberate stop',async()=>{
 const make=pauseSource=>harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{paused:true,pauseSource},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},result:{...fresh,facility:{id:'17',label:'Fitness'},snapshots:[{...fresh,view:{type:'day',date:'2026-10-18'}}]}});
 const p=make('maintenance');p.alarm();await until(()=>p.calls.capture===1);assert.equal(p.storage.paused,false);assert.equal(p.storage.pauseSource,'maintenance_complete');
 const stopped=make('manual_stop');stopped.alarm();await new Promise(r=>setImmediate(r));assert.equal(stopped.storage.paused,true);assert.equal(stopped.calls.capture,0);
});

test('the single tab reads a facility with one direct page call and records every real site action',async()=>{
 const week={...fresh,facility:{id:'17',label:'Fitness'},snapshots:[{...fresh,view:{type:'day',date:'2026-10-18'}}]};
 const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},
  recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async(_c,config)=>({phase:config.directRead===true?'ready':'preparing'})},
  directReader:function rezMainPage(){},result:week,
  directEvidence:(injection,evidence,at)=>({...evidence,actions:[at+5,at+1105],stats:{reused:false,selectionVerified:true,actions:2,ms:1400,requests:{unit:0,facility:1,schedule:1}}})});
 await p.pause(false);
 await until(()=>p.calls.ingestPayloads.some(x=>x.phase==='ready'));
 const injection=p.calls.injections.find(x=>x.func);
 assert.equal(injection.world,'MAIN');assert.equal(injection.args[0].mode,'read-step');assert.match(injection.args[0].token,/^[a-f0-9-]{36}$/);assert.equal(injection.args[0].facilityId,'17');
 assert.deepEqual(Array.from(injection.args[0].dates),['2026-10-18']);
 assert.deepEqual(p.storage.singleActionLog.map(x=>x.kind),['calendar','read']);
 const ready=p.calls.ingestPayloads.find(x=>x.phase==='ready');
 assert.equal(ready.readStats.selectionVerified,true);assert.equal(ready.readStats.requests.schedule,1);
 assert.ok(p.calls.ingestPayloads.some(x=>x.state==='ok'&&x.snapshots?.length===1));
});
test('a followed facility read again 11s after its last turn is really read: the old 18s fast-watch gate no longer burns the single tab turn',async()=>{
 const week={...fresh,facility:{id:'17',label:'Fitness'},snapshots:[{...fresh,view:{type:'day',date:'2026-10-18'}}]};
 const at=Date.parse('2026-10-18T12:00:00Z');
 const p=harness({configExtra:{autoManage:true,singleTab:true,fastWatch:true,priorityFacilities:['17'],watchFacilities:['17'],watchDates:['2026-10-18']},
  initialStorage:{facilityAttemptAt:{'17':at-11000},singleDispatchAt:{'17':at-11000}},
  recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},
  directReader:function rezMainPage(){},result:week,
  directEvidence:(injection,evidence,now)=>({...evidence,actions:[now+5],stats:{reused:true,selectionVerified:true,actions:1,ms:700,requests:{unit:0,facility:1,schedule:1}}})});
 await p.pause(false);
 await until(()=>p.calls.ingestPayloads.some(x=>x.state==='ok'&&x.snapshots?.length===1));
 assert.ok(p.calls.injections.some(x=>x.func&&x.args?.[0]?.mode==='read-step'&&x.args[0].facilityId==='17'));
});
test('a tab stuck on a browser error page is reloaded once after repeated failures, then waits',async()=>{
 const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},
  initialStorage:{singleTabId:7},directReader:function rezMainPage(){},
  recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>{throw new Error('Frame with ID 0 is showing error page');}},result:fresh});
 await p.pause(false);
 for(let i=0;i<14;i++){p.advance(5000);p.alarm();await until(()=>Number(p.storage.singleFailStreak||0)>0||p.calls.tabUpdates.length>0);await new Promise(r=>setImmediate(r));}
 assert.equal(p.calls.tabUpdates.length,1);
 assert.equal(p.calls.tabUpdates[0][0],7);assert.match(p.calls.tabUpdates[0][1].url,/^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf/);
 assert.equal(p.storage.singleHealCount,1);
});
test('browser-error retries stay at four minutes even after many failed reloads or a worker restart',async()=>{
 const at=Date.parse('2026-10-18T12:00:00Z');
 for(const heals of [0,1,2,20]){
  const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},
   initialStorage:{singleTabId:7,singleHealAt:at-239000,singleHealCount:heals,singleFailStreak:8,singleFailSince:at-60000},
   directReader:function rezMainPage(){},
   recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>{throw new Error('Frame with ID 0 is showing error page');}},result:fresh});
  p.alarm();await until(()=>p.storage.singleFailStreak===9);
  await new Promise(r=>setImmediate(r));
  assert.equal(p.calls.tabUpdates.length,0,`reload before four minutes, prior failures=${heals}`);
  p.advance(1000);p.alarm();await until(()=>p.calls.tabUpdates.length===1);
  assert.equal(p.calls.tabUpdates[0][0],7);
  assert.match(p.calls.tabUpdates[0][1].url,/^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf/);
  assert.equal(p.storage.singleHealCount,heals+1);
 }
});


test('partial week requires an exact disjoint partition and ingests no rejected day',async()=>{
 const dates=['2026-10-18','2026-10-19'],snap={...fresh,facility:{id:'17',label:'Fitness'},view:{type:'day',date:dates[1]}};
 const result={...snap,snapshots:[snap],rejectedDates:[dates[0]]};
 const opts={configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:dates},initialStorage:{singleTabId:7},directReader:function rezMainPage(){},directEvidence:(_i,e)=>e,recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})}};
 const p=harness({...opts,result});await p.pause(false);await until(()=>p.calls.ingestPayloads.some(x=>x.snapshots));
 assert.equal(p.calls.ingestPayloads.find(x=>x.snapshots).snapshots.length,1);assert.equal(p.calls.ingestPayloads.find(x=>x.snapshots).snapshots[0].view.date,dates[1]);
 for(const rejectedDates of [[dates[1]],[dates[0],dates[0]],['2026-10-20'],[]]){const q=harness({...opts,result:{...result,rejectedDates},directEvidence:(_i,e)=>({...e,dates})});await q.pause(false);await until(()=>q.calls.ingest>0);assert(!q.calls.ingestPayloads.some(x=>x.snapshots));}
});

test('a fast broken-page failure waits its own action gap, refreshes once, and resumes verified collection',async()=>{
 const at=Date.parse('2026-10-18T12:00:00Z'),bad={...fresh,state:'calendar_unavailable',fresh:false,detail:'primefaces_unavailable'},week={...fresh,snapshots:[{...fresh,view:{type:'day',date:'2026-10-18'}}]};
 const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7,singleFailStreak:7,singleFailSince:at-60000},budgetWait:async()=>{},directReader:function rezMainPage(){},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},resultSequence:[bad,week],directEvidence:(_i,e,now)=>({...e,actions:e.ok?[now]:[]})});
 await p.pause(false);await until(()=>p.storage.lastStatus?.detail==='primefaces_unavailable');
 assert.equal(p.calls.tabUpdates.length,1);assert.equal(p.calls.tabUpdates[0][0],7);
 assert.ok(p.calls.budgetWaits.some(ms=>ms>=1000));
 assert.ok(p.storage.singleActionLog[1].at-p.storage.singleActionLog[0].at>=1000);
 assert.equal(p.storage.singleHealRecord.outcome,'requested');
 assert.ok(p.calls.ingestPayloads.some(x=>x.phase==='reconnecting'));
 p.advance(30000);p.alarm();await until(()=>p.storage.singleHealRecord?.outcome==='resumed');
 await until(()=>p.calls.ingestPayloads.some(x=>x.phase==='ready'&&x.autoRefresh?.outcome==='resumed'));
 assert.ok(p.calls.ingestPayloads.some(x=>x.state==='ok'&&x.fresh===true));assert.equal(p.calls.tabUpdates.length,1);
});

test('broken framework recovery needs two persistent failures, and Stop or maintenance during its gap cancels refresh',async()=>{
 const at=Date.parse('2026-10-18T12:00:00Z'),bad={...fresh,state:'calendar_unavailable',fresh:false,detail:'primefaces_unavailable'};
 for(const cancel of [null,(_ms,s)=>s.paused=true,(_ms,_s,c)=>c.maintenance=true]){
  const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7,singleFailStreak:1,singleFailSince:at-30000},budgetWait:cancel||(async()=>{}),directReader:function rezMainPage(){},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},result:bad,directEvidence:(_i,e)=>({...e,actions:[]})});
  p.alarm();await until(()=>p.calls.budgetWaits.length>0);await new Promise(r=>setImmediate(r));
  assert.equal(p.calls.tabUpdates.length,cancel?0:1);
 }
});

test('a page that changes to login, challenge, a refusal or another URL while waiting is never refreshed',async()=>{
 const at=Date.parse('2026-10-18T12:00:00Z'),bad={...fresh,state:'calendar_unavailable',fresh:false,detail:'primefaces_unavailable'};
 for(const page of ['login','challenge','blocked','away']){
  const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7,singleFailStreak:7,singleFailSince:at-60000},budgetWait:async()=>{},directReader:function rezMainPage(){},recovery:{inspectPage:function inspectPage(){},ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},healPage:{page},tabsList:page==='away'?[{id:7,url:'https://example.invalid/'}]:null,result:bad,directEvidence:(_i,e)=>({...e,actions:[]})});
  p.alarm();await until(()=>p.storage.lastStatus?.detail==='primefaces_unavailable');assert.equal(p.calls.tabUpdates.length,0,page);
 }
});

test('the authenticated publication-wait acknowledgement prevents repeated heals but still collects, and fresh reads end waiting',async()=>{
 const at=Date.parse('2026-10-18T12:00:00Z'),bad={...fresh,state:'calendar_unavailable',fresh:false,detail:'calendar_date_mismatch'};
 const p=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7,singleFailStreak:7,singleFailSince:at-60000},budgetWait:async()=>{},directReader:function rezMainPage(){},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},result:bad,ingestReply:{waitingPublication:true},directEvidence:(_i,e)=>({...e,actions:[]})});
 for(let i=0;i<3;i++){p.alarm();await until(()=>p.calls.ingestPayloads.filter(x=>x.state==='calendar_unavailable').length>=i+1);await until(()=>p.calls.ingestPayloads.filter(x=>x.phase==='preparing').length>=i+1);p.advance(5*60000);}
 assert.equal(p.calls.tabUpdates.length,0);assert(!p.calls.ingestPayloads.some(x=>x.phase==='reconnecting'));assert.equal(p.storage.singleFailStreak,0);
 const q=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7,singleFailStreak:7,singleFailSince:at-60000},budgetWait:async()=>{},directReader:function rezMainPage(){},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},result:{...bad,detail:'primefaces_unavailable'},ingestReply:{waitingPublication:true},directEvidence:(_i,e)=>({...e,actions:[]})});
 q.alarm();await until(()=>q.calls.ingestPayloads.some(x=>x.phase==='reconnecting'));assert.equal(q.calls.tabUpdates.length,1,'the flag never masks another failure');
 let weekSeen=false;
 const r=harness({configExtra:{autoManage:true,singleTab:true,watchFacilities:['17'],watchDates:['2026-10-18']},initialStorage:{singleTabId:7},directReader:function rezMainPage(){},recovery:{ensureManagedTab:async()=>({id:7}),ensureReady:async()=>({phase:'ready'})},resultSequence:[bad,{...fresh,snapshots:[{...fresh,view:{type:'day',date:'2026-10-18'}}]},bad],ingestReply:body=>{if(body.fresh)weekSeen=true;return{waitingPublication:!weekSeen};},directEvidence:(_i,e,now)=>({...e,actions:e.ok?[now]:[]})});
 r.alarm();await until(()=>r.calls.ingestPayloads.some(x=>x.phase==='preparing'));r.advance(30000);
 r.alarm();await until(()=>r.calls.ingestPayloads.some(x=>x.phase==='ready'));assert.equal(weekSeen,true);r.advance(30000);
 r.alarm();await until(()=>r.calls.ingestPayloads.some(x=>x.phase==='reconnecting'));
 assert.equal(r.calls.ingestPayloads.filter(x=>x.phase==='preparing').length,1,'waiting ends after the first verified day');
});
