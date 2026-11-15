/* global chrome */
"use strict";
if (typeof importScripts === "function") importScripts("main.js","recovery.js","reader-clock.js","scheduler.js","catalog.js","parallel-reader.js","single-reader.js","memory-guard.js","verification.js");

const ALARM_NAME = "rez-calendar-capture";
const ALARM_PERIOD_MINUTES = 0.5;
// Fast mode: a 10s local tick alternates salons; persist >=9s globally and
// >=18s per salon. Legacy mode retains its one-minute total request gate.
const siteGap=config=>config.fastWatch===true&&config.autoManage===true?9000:60000;
const HOME_URL_RE = /^https:\/\/rez\.metu\.edu\.tr\/view\/home\.jsf(?:[?#]|$)/;
const LOGIN_URL_RE = /^https:\/\/rez\.metu\.edu\.tr\/(?:\?|#|$|index\.jsf(?:[?#]|$)|login|view\/login)/i;
const INGEST_URL = "http://127.0.0.1:8765/ingest";
const HEALTH_URL = "http://127.0.0.1:8765/health";
const SAFE_DETAILS = new Set([
  "rate_limited", "calendar_unavailable", "timeout", "ambiguous_request",
  "schedule_render_failed", "unverified_response", "no_schedule_request",
  "refresh_failed", "parse_failed", "unexpected_page", "login_form_present",
  "primefaces_unavailable", "schedule_widget_missing", "schedule_widget_unusable",
  "calendar_view_unavailable", "not_day_view", "calendar_date_unavailable",
  "calendar_date_mismatch", "calendar_date_expired", "calendar_day_advanced",
  "calendar_day_advance_failed", "facility_not_selected", "tab_query_failed",
  "content_no_response", "invalid_capture_payload", "content_timeout",
  "content_unreachable", "site_access_denied", "site_rate_limited"
]);
const SITE_BLOCK_DETAILS = new Set(["site_access_denied", "site_rate_limited"]);
let running = false;
const runningFacilities=new Set(),ingestControllers=new Set();
let catalogTask=null;
const parallelReader=typeof RezParallel!=='undefined'?RezParallel.create({chrome,now:()=>Date.now()}):null;
const memoryGuard=typeof RezMemoryGuard!=='undefined'?RezMemoryGuard.create({chrome,inspect:async tabId=>{const result=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'MAIN',func:RezRecovery.inspectPage});return result?.[0]?.result;},report:(config,record)=>reportReaderPhase({...config,memoryRecycleAck:record},'preparing',false)}):null;
const singleReader=typeof RezSingle!=='undefined'?RezSingle.create({chrome,now:()=>Date.now(),readConfig:()=>localConfig(),beforeTurn:async config=>{config.reserveMemoryPreparation=()=>parallelReader.reservePreparation(config,config.watchFacilities?.[0]);return memoryGuard?!await memoryGuard.maybeRotate(config):true;}}):null;
const verification=typeof RezVerification!=='undefined'?RezVerification.create({chrome,readConfig:localConfig,onReady:collectAndSend,nativeClick:async payload=>{
 const config=await localConfig();if(config.nativeVerification!==true)return false;
 const response=await fetch('http://127.0.0.1:8765/session/verification-click',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Key':config.key,'X-Rez-Extension':chrome.runtime.id},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
 return response.ok&&(await response.json()).ok===true;
},nativeReady:async()=>{
 const config=await localConfig();
 try{const response=await fetch('http://127.0.0.1:8765/session/verification-ready',{headers:{'X-Local-Key':config.key,'X-Rez-Extension':chrome.runtime.id},signal:AbortSignal.timeout(3000)});
  return response.ok?await response.json():{ready:false,retryable:true};
 }catch{return {ready:false,retryable:true};}
}}):null;
// One injected call selects the facility and captures its verified week.
const directReader=()=>typeof rezMainPage==='function'?rezMainPage:null;
// Repeated failures of these kinds can leave the one tab on a dead view or a
// browser error page; a budgeted reload of the same tab is the only remedy.
const HEALABLE=new Set(['network_wait','preparing','unverified_response','timeout','content_timeout','content_unreachable',
  'schedule_render_failed','primefaces_unavailable','schedule_widget_missing','schedule_widget_unusable','calendar_view_unavailable',
  'no_schedule_request','refresh_failed','unexpected_page','ambiguous_request','facility_not_selected','calendar_date_mismatch']);
let pauseRevision = 0;
let activeIngestController = null;
let pauseStatusPromise = Promise.resolve();

function invalidateAttempt() {
  pauseRevision += 1;
  // Abort a pending local request as soon as Stop is received. A request the
  // local server already accepted cannot be recalled by a browser abort.
  activeIngestController?.abort();
  for(const controller of ingestControllers)controller.abort();
}

function pauseMetadata(source) {
  return { pauseChangedAt: new Date().toISOString(), pauseSource: source };
}

function emptyPayload(state, detail) {
  const payload = {
    schema: 1,
    source: "rez-calendar-extension",
    observed_at: new Date().toISOString(),
    fresh: false,
    state,
    facility: null,
    view: { type: "unknown", date: null },
    slots: []
  };
  if (state === "calendar_unavailable") {
    payload.detail = SAFE_DETAILS.has(detail) ? detail : "calendar_unavailable";
  }
  return payload;
}

async function ensureAlarm() {
  const current = await chrome.alarms.get(ALARM_NAME);
  // Wake more often than the 60-second request gate. An alarm that arrives a
  // few milliseconds before the gate opens then costs at most one 30-second
  // wakeup instead of an entire additional minute. Replaces older 1m alarms.
  if (current?.periodInMinutes !== ALARM_PERIOD_MINUTES) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
}

async function localConfig() {
  const response = await fetch(chrome.runtime.getURL("local-config.json"), { cache: "no-store" });
  if (!response.ok) throw new Error("config_missing");
  const config = await response.json();
  if (config?.ingestUrl !== INGEST_URL || !/^[a-f0-9]{32,128}$/i.test(config?.key || "")) {
    throw new Error("config_invalid");
  }
  return config;
}

async function receiverReady(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(HEALTH_URL, {
      method: "GET",
      headers: { "X-Local-Key": config.key },
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) return false;
    const health = await response.json();
    config.sessionCatalog=health?.sessionCatalog||{};
    if(health?.ok)await chrome.storage.local.set({serviceHealth:{reader:health.reader||null,
      telegramPollAt:health.telegram?.lastPollAt||null,at:new Date().toISOString()}});
    return health?.ok === true;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function after(ms, promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function capture(config = {}) {
  let targetTab = null;
  let expectedFacility = null;
  if (config.autoManage === true && typeof RezRecovery !== 'undefined') {
    const facilities = config.watchFacilities;
    if (!Array.isArray(facilities) || !facilities.length || facilities.length > 200
      || facilities.some(id => !/^\d{1,4}$/.test(id))) return emptyPayload('calendar_unavailable','invalid_capture_payload');
    const {watchCursor=0}=await chrome.storage.local.get('watchCursor');
    const cursor=Number.isSafeInteger(watchCursor)?watchCursor%facilities.length:0;
    const selection=config.readFacilityId?{facilityId:config.readFacilityId,advance:{}}:typeof RezScheduler!=='undefined'?RezScheduler.select(config,await chrome.storage.local.get(['watchCursor','scanTurn','priorityCursor','backgroundCursor'])):{facilityId:facilities[cursor],advance:{watchCursor:(cursor+1)%facilities.length}};
    expectedFacility=selection.facilityId;
    if(config.singleTab)config.reservePreparation=()=>parallelReader.reservePreparation(config,expectedFacility);
    if(config.singleTab&&directReader())config.directRead=true;
    let ready;
    try {
      targetTab=await RezRecovery.ensureManagedTab(chrome,config,expectedFacility);
      if(!targetTab)return {readerPhase:'preparing'};
      ready=await RezRecovery.ensureReady(chrome,config,targetTab,expectedFacility);
    } catch {return {readerPhase:'network_wait'};}
    if(ready?.phase!=='ready') {
      await chrome.storage.local.set(selection.advance);
      return {readerPhase:ready?.phase||'network_wait',readerFacilityId:expectedFacility};
    }
    const {lastAttemptAt=0,facilityAttemptAt={}}=await chrome.storage.local.get(['lastAttemptAt','facilityAttemptAt']);
    if(config.parallelRead===true||config.singleTab===true){if(!parallelReader||!await (config.singleTab===true&&parallelReader.reserveWithin?parallelReader.reserveWithin(config,expectedFacility):parallelReader.reserve(config,expectedFacility)))return {rateWait:true};}
    else if(Date.now()-Number(lastAttemptAt)<siteGap(config))return {rateWait:true};
    // The shared budget above already enforces each facility's own interval.
    // This older 18s gate ran after that reservation, so in the single tab it
    // refused every 10s turn of a followed facility and that facility was
    // never read again (0.10.6, 29 Oct 2026).
    if(config.fastWatch===true&&config.parallelRead!==true&&config.singleTab!==true&&Date.now()-Number(facilityAttemptAt[expectedFacility]||0)<18000)return {rateWait:true};
    // An early local tick or fallback alarm must not consume a salon turn.
    await chrome.storage.local.set(selection.advance);
  } else {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: "https://rez.metu.edu.tr/*" });
  } catch (_error) {
    return emptyPayload("calendar_unavailable", "tab_query_failed");
  }
  const { targetTabId = null } = await chrome.storage.local.get("targetTabId");
  const pinned = Number.isInteger(targetTabId)
    ? tabs.find((tab) => tab.id === targetTabId) : null;
  if (pinned && !HOME_URL_RE.test(pinned.url || "")) {
    return emptyPayload(LOGIN_URL_RE.test(pinned.url || "") ? "login_required" : "no_tab");
  }
  const homeTabs = tabs.filter((tab) => HOME_URL_RE.test(tab.url || ""));
  if (!homeTabs.length) {
    const loginTab = tabs.some((tab) => LOGIN_URL_RE.test(tab.url || ""));
    return emptyPayload(loginTab ? "login_required" : "no_tab");
  }
  targetTab = pinned || null;
  const watchTabs = Array.isArray(config.watchTabs) ? config.watchTabs : [];

  if (watchTabs.length) {
    if (watchTabs.length > 2 || watchTabs.some(item => !Number.isInteger(item.tabId)
      || !/^\d{1,4}$/.test(item.facilityId || ''))) return emptyPayload('calendar_unavailable', 'invalid_capture_payload');
    // Two deliberately configured weekly calendars share the existing global
    // 60-second request gate; extra user tabs never enter this rotation.
    if (watchTabs.some(item => !homeTabs.some(tab => tab.id === item.tabId))) return emptyPayload('no_tab');
    const { watchCursor = 0 } = await chrome.storage.local.get('watchCursor');
    const index = Number.isSafeInteger(watchCursor) ? watchCursor % watchTabs.length : 0;
    const chosen = watchTabs[index];
    targetTab = homeTabs.find(tab => tab.id === chosen.tabId);
    expectedFacility = chosen.facilityId;
    await chrome.storage.local.set({ watchCursor: (index + 1) % watchTabs.length });
  }
  // Chrome can assign a new tab ID after a closed tab is reopened. Rebind
  // only when exactly one signed-in home tab is available; with multiple
  // candidates the user must choose by manually restarting the extension.
  if (!watchTabs.length && Number.isInteger(targetTabId) && !targetTab && homeTabs.length !== 1) {
    return emptyPayload("no_tab");
  }
  if (!targetTab) {
    homeTabs.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
    targetTab = homeTabs[0];
    await chrome.storage.local.set({ targetTabId: targetTab.id });
  }
  }
  try {
    // Tab lookup can also be slow. Persist the gate beside the only operation
    // that can actually ask the reservation site for a new calendar.
    const {facilityAttemptAt={}}=await chrome.storage.local.get('facilityAttemptAt');
    await chrome.storage.local.set({ lastAttemptAt: Date.now(),...(expectedFacility&&!config.parallelRead&&!config.singleTab?{facilityAttemptAt:{...facilityAttemptAt,[expectedFacility]:Date.now()}}:{}) });
    // The browser returns the MAIN-world Promise through InjectionResult.
    // Site scripts cannot impersonate it by racing a window.postMessage.
    const direct = config.directRead === true && Boolean(expectedFacility);
    const injections = direct ? await directRead(targetTab.id, { facilityId: expectedFacility,
      unitId: config.watchFacilityUnits?.[expectedFacility] || null, dates: config.watchDates, minGapMs: 1000 })
      : await after(20_000, chrome.scripting.executeScript({
        target: { tabId: targetTab.id, frameIds: [0] },
        files: ["main.js"],
        world: "MAIN"
      }));
    if (direct) config.lastReadStats = readStats(injections?.[0]?.result?.stats);
    if (!Array.isArray(injections) || injections.length !== 1
      || injections[0]?.frameId !== 0 || !injections[0].result) {
      return emptyPayload("calendar_unavailable", "invalid_capture_payload");
    }
    const evidence = injections[0].result;
    if (evidence.ok !== true) {
      if (evidence.reason === "login_required" || evidence.reason === "login_form_present") {
        return {...emptyPayload("login_required"), ...(config.autoManage ? {recoveryTabId:targetTab.id} : {})};
      }
      return emptyPayload("calendar_unavailable", evidence.reason);
    }
    if (expectedFacility && (evidence.facilityId !== expectedFacility || evidence.viewType !== 'week')) {
      return emptyPayload('calendar_unavailable', 'invalid_capture_payload');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.date || "")
      || !/^\d{1,4}$/.test(evidence.facilityId || "")
      || !/^[a-f0-9-]{16,80}$/i.test(evidence.refreshId || "")
      || !Array.isArray(evidence.events) || evidence.events.length > 1000) {
      return emptyPayload("calendar_unavailable", "invalid_capture_payload");
    }
    let result;
    try {
      result = await after(3000, chrome.tabs.sendMessage(targetTab.id,
        { type: "rez:parse", evidence, sessionCatalog:config.sessionCatalog||{} }, { frameId: 0 }));
    } catch (_error) {
      // After an extension update or tab discard, MAIN may still refresh the
      // calendar while the old isolated listener is gone. Restore only the
      // parser/listener and reuse the same verified AJAX evidence; do not make
      // another site request or bypass the persistent 60-second gate.
      await after(3000, chrome.scripting.executeScript({
        target: { tabId: targetTab.id, frameIds: [0] },
        files: ["parser.js", "content.js"], world: "ISOLATED"
      }));
      result = await after(3000, chrome.tabs.sendMessage(targetTab.id,
        { type: "rez:parse", evidence, sessionCatalog:config.sessionCatalog||{} }, { frameId: 0 }));
    }
    if (result == null) return emptyPayload("calendar_unavailable", "content_no_response");
    if (evidence.viewType === 'week' && result.state !== 'login_required' && !result.snapshots) {
      // Already-open tabs may still have the previous day-only parser after
      // an extension reload. Replace that listener, reusing this AJAX proof.
      await after(3000, chrome.scripting.executeScript({
        target: { tabId: targetTab.id, frameIds: [0] },
        files: ['parser.js', 'content.js'], world: 'ISOLATED'
      }));
      result = await after(3000, chrome.tabs.sendMessage(targetTab.id,
        {type:'rez:parse', evidence,sessionCatalog:config.sessionCatalog||{}}, {frameId:0}));
      if (!result) return emptyPayload('calendar_unavailable', 'content_no_response');
    }
    if (result.snapshots !== undefined) {
      const rejected=result.rejectedDates ?? [];
      const covered=[...(Array.isArray(result.snapshots)?result.snapshots.map(item=>item.view?.date):[]),...(Array.isArray(rejected)?rejected:[])];
      if(!Array.isArray(rejected)||rejected.length>6||rejected.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d))
        ||!Array.isArray(evidence.dates)||new Set(covered).size!==covered.length
        ||covered.length!==evidence.dates.length||covered.some(d=>!evidence.dates.includes(d)))return emptyPayload('calendar_unavailable','invalid_capture_payload');
      if (!Array.isArray(result.snapshots) || !result.snapshots.length || result.snapshots.length > 7
        || result.snapshots.length + rejected.length !== evidence.dates?.length
        || result.snapshots.some(item => item?.state !== 'ok' || item.fresh !== true
          || item.facility?.id !== evidence.facilityId || item.refresh_id !== evidence.refreshId)
        || new Set(result.snapshots.map(item => item.view?.date)).size !== result.snapshots.length) {
        return emptyPayload('calendar_unavailable', 'invalid_capture_payload');
      }
      const dates = config.watchDates;
      const snapshots = Array.isArray(dates) ? result.snapshots.filter(item => dates.includes(item.view.date)) : result.snapshots;
      if (!snapshots.length || (Array.isArray(dates) && snapshots.length + rejected.filter(d=>dates.includes(d)).length !== dates.length)) {
        return emptyPayload('calendar_unavailable', 'calendar_date_mismatch');
      }
      result = { ...snapshots[0], snapshots, ...(rejected.length?{rejectedDates:rejected}: {}) };
    }
    if (result?.schema !== 1 || (result.state === "ok" && (result.fresh !== true
      || !/^[a-f0-9-]{16,80}$/i.test(result.refresh_id || "")))
      || (result.state !== "ok" && result.fresh !== false)
      || !Array.isArray(result.slots)
      || !["ok", "login_required", "calendar_unavailable"].includes(result.state)) {
      return emptyPayload("calendar_unavailable", "invalid_capture_payload");
    }
    if (result.state === "calendar_unavailable") {
      result.detail = SAFE_DETAILS.has(result.detail) ? result.detail : "calendar_unavailable";
      if(result.detail==='parse_failed')result.readerDiagnostic={schema:1,facilityId:evidence.facilityId,
        date:evidence.date,dates:evidence.dates||[],clippedDate:evidence.clippedDate||null,
        domDates:result.parserDomDates||[],events:evidence.events.slice(0,50).map(e=>({start:e.start,end:e.end,
          allDay:e.allDay===true,free:e.title?.match(/(?:Boş|Bos)\s*:\s*(\d+)/i)?.[1]??null}))};
      delete result.parserDomDates;
    } else {
      delete result.detail;
    }
    return result;
  } catch (error) {
    return emptyPayload("calendar_unavailable",
      error?.message === "timeout" ? "content_timeout" : "content_unreachable");
  }
}

async function postSnapshot(config, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(config.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Local-Key": config.key },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return response.ok;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function queuePauseStatus(payload, knownConfig = null) {
  pauseStatusPromise = pauseStatusPromise.catch(() => {}).then(async () => {
    try {
      return await postSnapshot(knownConfig || await localConfig(), payload);
    } catch (_error) {
      return false;
    }
  });
  return pauseStatusPromise;
}

async function saveStatus(state, detail, payload, extra = {}) {
  await chrome.storage.local.set({
    ...extra,
    lastStatus: {
      state,
      detail,
      at: new Date().toISOString(),
      facility: String(payload?.facility?.label || "").slice(0, 80),
      slots: payload?.snapshots ? payload.snapshots.reduce((n, item) => n + item.slots.length, 0)
        : Array.isArray(payload?.slots) ? payload.slots.length : 0,
      fresh: payload?.fresh === true
    }
  });
}

// Drives one facility read with short page calls. The page never waits on its
// own timers (Chrome throttles them in a hidden tab); this worker does.
async function directRead(tabId, request) {
  const token = crypto.randomUUID(), deadline = Date.now() + 45_000;
  const call = args => after(5_000, chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN",
    func: directReader(), args: [args] }));
  const stepOf = frames => frames?.length === 1 && frames[0]?.frameId === 0 ? frames[0].result : null;
  let finished;
  try {
    for (;;) {
      const step = stepOf(await call({ ...request, mode: "read-step", token }));
      if (!step) throw new Error("page_unavailable");
      if (step.done) { finished = step.result; break; }
      if (Date.now() > deadline) { finished = stepOf(await call({ mode: "read-abort", token }))?.result; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(50, Number(step.retryAfterMs) || 100))));
    }
  } catch (error) {
    // Remove the page hook and count what the page did before the failure.
    const aborted = await call({ mode: "read-abort", token }).then(stepOf).catch(() => null);
    const actions = aborted?.result?.actions;
    await parallelReader.recordActions(request.facilityId, Array.isArray(actions) && actions.length ? actions : [Date.now(), Date.now()]).catch(() => {});
    throw error;
  }
  if (Array.isArray(finished?.actions)) await parallelReader.recordActions(request.facilityId, finished.actions);
  return [{ frameId: 0, result: finished || { ok: false, reason: "timeout" } }];
}

function readStats(value) {
  if (!value || typeof value !== "object") return null;
  const count = (n, max) => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : 0;
  return { reused: value.reused === true, weekDefault: value.weekDefault === true, selectionVerified: typeof value.selectionVerified === "boolean" ? value.selectionVerified : null,
    actions: count(value.actions, 10), ms: count(value.ms, 120000),
    requests: { unit: count(value.requests?.unit, 10), facility: count(value.requests?.facility, 10), schedule: count(value.requests?.schedule, 10) },
    events: count(value.events, 1000), otherEvents: count(value.otherEvents, 1000),
    otherTitles: (Array.isArray(value.otherTitles) ? value.otherTitles : []).filter(t => typeof t === "string" && t.length <= 40 && !t.includes("@")).slice(0, 5) };
}

async function noteSingleOutcome(config, facilityId, ok, kind) {
  if (!config.singleTab || !config.autoManage) return;
  if (ok) {
    const {singleHealRecord}=await chrome.storage.local.get('singleHealRecord');
    await chrome.storage.local.set({ singleFailStreak: 0, singleFailSince: 0, singleHealCount: 0,
      ...(singleHealRecord?.outcome==='requested'?{singleHealRecord:{...singleHealRecord,outcome:'resumed',resumedAt:new Date().toISOString()}}:{}) });
    return;
  }
  if (!HEALABLE.has(kind)) return;
  const revision=pauseRevision;
  const s = await chrome.storage.local.get(["singleFailStreak", "singleFailSince", "singleHealAt", "singleHealCount", "singleTabId"]);
  const now = Date.now(), streak = Number(s.singleFailStreak || 0) + 1, since = Number(s.singleFailSince || 0) || now;
  await chrome.storage.local.set({ singleFailStreak: streak, singleFailSince: since });
  // Keep checking an unavailable site every four minutes, including after a
  // long outage or a worker restart. The shared site-action budget still applies.
  const heals = Number(s.singleHealCount || 0), backoff = 4 * 60_000;
  const brokenPage=['primefaces_unavailable','schedule_widget_missing','schedule_widget_unusable','calendar_view_unavailable','content_unreachable'].includes(kind);
  if (streak < (brokenPage?2:8) || now - since < (brokenPage?15_000:45_000) || now - Number(s.singleHealAt || 0) < backoff || !Number.isInteger(s.singleTabId)) return;
  // A fast failure has just reserved the calendar action. Waiting for the
  // remainder of its 1s pace prevents every refresh from losing to itself.
  if (!facilityId || !parallelReader || !await parallelReader.reservePreparationWithin(config, facilityId)) return;
  const current=await chrome.storage.local.get(['paused','singleTabId']);
  const latest=await localConfig();
  if(revision!==pauseRevision||current.paused!==false||current.singleTabId!==s.singleTabId||latest.maintenance||!latest.autoManage)return;
  const tab=chrome.tabs.get?await chrome.tabs.get(s.singleTabId):{url:'https://rez.metu.edu.tr/view/home.jsf'};
  if(!HOME_URL_RE.test(tab.url||''))return;
  if(typeof RezRecovery?.inspectPage==='function'){
    const inspection=await after(3000,chrome.scripting.executeScript({target:{tabId:s.singleTabId,frameIds:[0]},world:'MAIN',func:RezRecovery.inspectPage})).catch(()=>null);
    if(['login','challenge','blocked'].includes(inspection?.[0]?.result?.page))return;
  }
  const finalState=await chrome.storage.local.get('paused');
  if(finalState.paused!==false||revision!==pauseRevision||(await localConfig()).maintenance)return;
  await chrome.storage.local.set({ singleHealAt: now, singleHealCount: heals + 1, singleFailStreak: 0, singleFailSince: 0,
    singleReaderJob:null,singleHealRecord:{at:new Date().toISOString(),reason:kind,outcome:'requested'} });
  await chrome.tabs.update(s.singleTabId, { url: "https://rez.metu.edu.tr/view/home.jsf?rez-reader=1" }).catch(() => {});
}

async function reportReaderPhase(config,phase,show=true,currentFacilityId=null) {
  const {singleHealRecord}=await chrome.storage.local.get('singleHealRecord');
  const response=await fetch('http://127.0.0.1:8765/reader-state',{method:'POST',
    headers:{'Content-Type':'application/json','X-Local-Key':config.key},
    body:JSON.stringify({phase,currentFacilityId,...(config.watchFacilities?.length?{facilityIds:config.watchFacilities,dates:config.watchDates}:{}),version:chrome.runtime.getManifest?.().version||'0.8.1',maxFacilities:200,memoryGuard:true,...(singleHealRecord?{autoRefresh:singleHealRecord}:{}),...(config.memoryRecycleAck?{memoryRecycle:config.memoryRecycleAck}:{}),catalogDiscovery:true,parallelRead:config.singleTab!==true,singleTab:config.singleTab===true,priorityFacilities:config.priorityFacilities||[],scanMode:config.scanMode||'round-robin',...(phase==='ready'&&config.lastReadStats?{readStats:config.lastReadStats}:{})}),
    signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('local_server_unavailable');
  if(show)await saveStatus('recovering',phase,null);
}

async function collectOne(facilityId=null) {
  const runKey=facilityId||'legacy';
  if((!facilityId&&running)||runningFacilities.has(runKey)||facilityId&&runningFacilities.size>=4)return;
  if(!facilityId)running=true;runningFacilities.add(runKey);
  const attemptRevision = pauseRevision;
  try {
    if(typeof readerClock!=='undefined')void readerClock?.ensure();
    await pauseStatusPromise;
    const { paused = true } = await chrome.storage.local.get("paused");
    if (paused || attemptRevision !== pauseRevision) return;
    const { lastAttemptAt = 0 } = await chrome.storage.local.get("lastAttemptAt");
    const now = Date.now();
    // This persisted gate is authoritative across one-shot MAIN injections,
    // service-worker restarts, and Stop/Start. No retry branch may bypass it.
    const config = await localConfig();
    if(config.maintenance)return;
    if(facilityId){if(!config.watchFacilities?.includes(facilityId))return;config.readFacilityId=facilityId;}
    if (!config.autoManage && now - Number(lastAttemptAt) < 60_000) return;
    if (Array.isArray(config.watchDates) && config.watchDates.length) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone:'Europe/Istanbul', year:'numeric', month:'2-digit', day:'2-digit'
      }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type,part.value]));
      const today = `${parts.year}-${parts.month}-${parts.day}`;
      if (config.watchDates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today)) {
        invalidateAttempt();
        await chrome.storage.local.set({paused:true, pausedReason:null, ...pauseMetadata('watch_complete')});
        const payload = emptyPayload('paused');
        await queuePauseStatus(payload, config);
        await saveStatus('paused', 'local_sent', payload);
        return;
      }
      config.watchDates = config.watchDates.filter(date => date >= today);
    }
    if (!await receiverReady(config)) {
      const afterHealth = await chrome.storage.local.get("paused");
      if (afterHealth.paused !== false || attemptRevision !== pauseRevision) return;
      await saveStatus("error", "local_server_unavailable", null);
      return;
    }
    const beforeCapture = await chrome.storage.local.get("paused");
    if (beforeCapture.paused !== false || attemptRevision !== pauseRevision) return;
    if(!config.parallelRead&&!config.singleTab&&config.catalogDiscovery&&typeof RezCatalog!=='undefined'){
      const catalogResult=await RezCatalog.run(chrome,config).catch(()=>null);
      if(catalogResult?.phase==='site_access_denied'){await chrome.storage.local.set({paused:true,pausedReason:'site_access_denied',...pauseMetadata('site_access_denied')});await queuePauseStatus(emptyPayload('calendar_unavailable','site_access_denied'),config);return;}
    }
    const payload = await capture(config);
    await chrome.storage.local.set({ lastCaptureEndAt: new Date().toISOString() });
    const afterCapture = await chrome.storage.local.get("paused");
    if (afterCapture.paused !== false || attemptRevision !== pauseRevision) return;
    if (payload.rateWait) return;
    if (payload.readerPhase) {
      if (SITE_BLOCK_DETAILS.has(payload.readerPhase)) {
        invalidateAttempt();
        await chrome.storage.local.set({paused:true,pausedReason:payload.readerPhase,...pauseMetadata(payload.readerPhase)});
        await queuePauseStatus(emptyPayload('calendar_unavailable',payload.readerPhase),config);
      }
      await noteSingleOutcome(config,facilityId||payload.readerFacilityId,false,payload.readerPhase);
      await reportReaderPhase(config,payload.readerPhase,true,facilityId||payload.readerFacilityId);
      return;
    }
    if(config.autoManage && payload.state==='login_required') {
      if(payload.recoveryTabId&&config.singleTab){
        await chrome.storage.local.set({sessionRecoveryTabId:payload.recoveryTabId});
      } else if(payload.recoveryTabId) {
        await chrome.storage.local.set({lastRecoveryActionAt:Date.now()});
        await chrome.tabs.update(payload.recoveryTabId,{url:'https://rez.metu.edu.tr/view/home.jsf'});
      }
      await reportReaderPhase(config,'signing_in',true,facilityId);
      return;
    }
    if (payload.state === "calendar_unavailable" && payload.detail === "rate_limited") {
      // A one-shot page invocation should never hit this; preserve coverage
      // without creating an exceptional fast retry path if it does.
      return;
    }
    if (payload.state === "calendar_unavailable" && SITE_BLOCK_DETAILS.has(payload.detail)) {
      // Respect an explicit site denial. Resuming requires a deliberate user
      // action after checking that access is available again.
      invalidateAttempt();
      const haltRevision = pauseRevision;
      await chrome.storage.local.set({ paused: true, pausedReason: payload.detail,
        ...pauseMetadata(payload.detail) });
      const delivered = await queuePauseStatus(payload, config);
      if (haltRevision === pauseRevision) {
        await saveStatus(payload.state, payload.detail, payload,
          delivered ? { lastIngestAt: new Date().toISOString() } : {});
      }
      return;
    }
    if (payload.state === "login_required") {
      // No signed-in calendar can be read until the user signs in again.
      // Stop automated site retries; the user can resume from the popup.
      invalidateAttempt();
      const haltRevision = pauseRevision;
      await chrome.storage.local.set({ paused: true, pausedReason: "login_required",
        ...pauseMetadata("login_required") });
      const delivered = await queuePauseStatus(payload, config);
      if (haltRevision === pauseRevision) {
        await saveStatus(payload.state, null, payload,
          delivered ? { lastIngestAt: new Date().toISOString() } : {});
      }
      return;
    }
    const controller = new AbortController();
    activeIngestController = controller;ingestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(config.ingestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Local-Key": config.key
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) throw new Error("local_server_unavailable");
      const acknowledgement=typeof response.json==='function'?await response.json().catch(()=>({})):{};
      const afterIngest = await chrome.storage.local.get("paused");
      if (afterIngest.paused !== false || attemptRevision !== pauseRevision) return;
      // Only the authenticated receiver can confirm the exact future-plan
      // exception. It knows whether any new-week day was already verified.
      const waitingPublication=payload.state==='calendar_unavailable'&&payload.detail==='calendar_date_mismatch'
        &&payload.fresh===false&&acknowledgement?.waitingPublication===true;
      if(waitingPublication)await chrome.storage.local.set({singleFailStreak:0,singleFailSince:0});
      else await noteSingleOutcome(config,facilityId,payload.fresh===true,payload.detail);
      if(config.autoManage&&waitingPublication)await reportReaderPhase(config,'preparing',false,facilityId);
      else if(config.autoManage&&payload.state==='calendar_unavailable'&&HEALABLE.has(payload.detail))await reportReaderPhase(config,'reconnecting',false,facilityId);
      if(config.autoManage && payload.fresh) {
        await chrome.storage.local.set({lastSessionReadyAt:Date.now(),authAttempts:0,authSubmittedAt:0,authBlocked:false});
        await reportReaderPhase(config,'ready',false,facilityId||payload.facility?.id);
      }
      await saveStatus(payload.state,
        payload.state === "calendar_unavailable"
          ? (SAFE_DETAILS.has(payload.detail) ? payload.detail : "calendar_unavailable")
          : "local_sent", payload, { lastIngestAt: new Date().toISOString() });
    } finally {
      clearTimeout(timeout);ingestControllers.delete(controller);
      if (activeIngestController === controller) activeIngestController = null;
    }
  } catch (error) {
    const afterError = await chrome.storage.local.get("paused");
    if (afterError.paused !== false || attemptRevision !== pauseRevision) return;
    const code = ["config_missing", "config_invalid", "local_server_unavailable", "timeout"]
      .includes(error?.message) ? error.message : "local_server_unavailable";
    await saveStatus("error", code, null);
  } finally {
    if(!facilityId)running=false;runningFacilities.delete(runKey);
  }
}

const readerClock=typeof RezReaderClock!=='undefined'?RezReaderClock.createReaderClock({chrome,readConfig:localConfig,onTick:collectAndSend}):null;
async function collectAndSend(){
  let config;try{config=await localConfig();}catch{return collectOne();}
  if(config.maintenance)return;
  if(config.singleTab&&singleReader){
    const status=await chrome.storage.local.get(['paused','pauseSource']);
    if(status.paused&&status.pauseSource==='maintenance'&&config.autoManage)await chrome.storage.local.set({paused:false,...pauseMetadata('maintenance_complete')});
    else if(status.paused)return;
    void readerClock?.ensure();
    // Discovery and calendar selection share the same single tab. Never
    // change its directorate while another capture is using it.
    return singleReader.pump(config,async id=>{
      config.reservePreparation=()=>parallelReader.reservePreparation(config,id);
      if(config.catalogDiscovery&&typeof RezCatalog!=='undefined'){
        const result=await RezCatalog.run(chrome,config).catch(async()=>{await chrome.storage.local.set({catalogJob:null,catalogLastSweepAt:Date.now()});return {deferred:true};});
        if(SITE_BLOCK_DETAILS.has(result?.phase)){invalidateAttempt();await chrome.storage.local.set({paused:true,pausedReason:result.phase,...pauseMetadata(result.phase)});await queuePauseStatus(emptyPayload('calendar_unavailable',result.phase),config);return;}
        if(result?.phase)await reportReaderPhase(config,result.phase,true,id);
        if(result?.pending)return;
      }
      return collectOne(id);
    });
  }
  if(config.parallelRead!==true||!parallelReader)return collectOne();
  const {paused=true}=await chrome.storage.local.get('paused');if(paused)return;
  void readerClock?.ensure();
  if(config.catalogDiscovery&&typeof RezCatalog!=='undefined'&&!catalogTask){
    catalogTask=RezCatalog.run(chrome,config).then(async result=>{
      if(result?.phase==='site_access_denied'){invalidateAttempt();await chrome.storage.local.set({paused:true,pausedReason:'site_access_denied',...pauseMetadata('site_access_denied')});await queuePauseStatus(emptyPayload('calendar_unavailable','site_access_denied'),config);}
    }).catch(()=>{}).finally(()=>{catalogTask=null;});
  }
  return parallelReader.pump(config,id=>collectOne(id));
}

chrome.runtime.onInstalled.addListener(async () => {
  invalidateAttempt();
  const prior=await chrome.storage.local.get(['paused','pauseSource']);
  const config=await localConfig().catch(()=>null);
  const stopped=['manual_stop','site_access_denied','site_rate_limited','login_failed'].includes(prior.pauseSource);
  const keepRunning=config?.autoManage===true&&!config?.maintenance&&!stopped;
  const source=stopped?prior.pauseSource:config?.maintenance?'maintenance':'update';
  await chrome.storage.local.set({paused:!keepRunning,pausedReason:null,targetTabId:null,singleReaderJob:null,catalogJob:null,...pauseMetadata(source)});
  if(config?.singleTab)await reportReaderPhase(config,keepRunning?'preparing':'paused',false).catch(()=>{});
  await ensureAlarm();
  if(keepRunning)void collectAndSend();
});
chrome.runtime.onStartup.addListener(() => {void ensureAlarm();void collectAndSend();});
if(chrome.tabs.onUpdated)chrome.tabs.onUpdated.addListener((_id,change,tab)=>{
  if(change.status==='complete'&&/^https:\/\/rez\.metu\.edu\.tr\//.test(tab.url||''))void collectAndSend();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void (async () => {
      await chrome.storage.local.set({ lastAlarmAt: new Date().toISOString() });
      await collectAndSend();
    })();
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if(verification?.handleMessage(message,_sender,sendResponse))return true;
  if (['rez:session-status','rez:save-credentials'].includes(message?.type)) {
    (async()=>{
      const config=await localConfig();
      const result=await RezRecovery.credentialRequest(chrome,config,
        message.type==='rez:session-status'?'status':'credentials',
        message.type==='rez:session-status'?'GET':'POST',
        message.type==='rez:save-credentials'?{username:message.username,password:message.password}:undefined);
      if(message.type==='rez:save-credentials'){
        await chrome.storage.local.set({authBlocked:false,authAttempts:0,authSubmittedAt:0});
        void collectAndSend();
      }
      sendResponse({ok:true,...result});
    })().catch(()=>sendResponse({ok:false,error:'credentials_unavailable'}));return true;
  }
  if (message?.type !== "rez:set-paused") return;
  (async () => {
    const paused = Boolean(message.paused);
    invalidateAttempt();
    const actionRevision = pauseRevision;
    await chrome.storage.local.set({ paused, pausedReason: null, targetTabId: null,
      ...(paused ? {} : { lastStatus: null,authBlocked:false,authAttempts:0,authSubmittedAt:0 }),
      ...pauseMetadata(paused ? "manual_stop" : "manual_start") });
    await ensureAlarm();
    if (paused) {
      readerClock?.disconnect();
      const payload = emptyPayload("paused");
      const delivered = await queuePauseStatus(payload);
      if (actionRevision === pauseRevision) {
        await saveStatus("paused", delivered ? "local_sent" : "local_server_unavailable", payload,
          delivered ? { lastIngestAt: new Date().toISOString() } : {});
      }
    } else {
      void collectAndSend();
    }
    sendResponse({ ok: true, paused });
  })().catch(() => sendResponse({ ok: false }));
  return true;
});

void ensureAlarm();

void readerClock?.ensure();
