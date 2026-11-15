import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../main.js';

const { createReader } = globalThis.RezRefreshMain;
const WEEK = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];

function partial({ error = false, redirect = false } = {}) {
  return { documentElement: { localName: 'partial-response' },
    getElementsByTagName: name => name === 'error' && error || name === 'redirect' && redirect ? [{}] : [] };
}
function scheduleXml(events) {
  const update = { getAttribute: name => name === 'id' ? 'form:myschedule' : null, textContent: JSON.stringify({ events }) };
  return { documentElement: { localName: 'partial-response' }, getElementsByTagName: name => name === 'update' ? [update] : [] };
}

// A small PrimeFaces-like page: the server keeps its own selected facility,
// the hidden input changes before the behavior response, and a successful
// facility response can re-render the schedule, which then loads its events.
function site({ facility = '17', serverFacility = facility, view = 'agendaWeek', autoLoad = true,
  facilityFailure = null, dates = WEEK, recreate = false, sundayRange = false } = {}) {
  const inputs = { 'form:facility_input': { value: facility }, 'form:unit_input': { value: '' } };
  const server = { facility: serverFacility };
  const requests = [];
  let pending = 0;
  let viewName = view;
  let shown = dates.slice();
  const env = {};
  const respond = (fn) => { pending += 1; setTimeout(() => { pending -= 1; fn(); }, 5); };
  const original = function (options) {
    requests.push({ source: options.source, facility: server.facility });
    if (options.source === 'form:myschedule') {
      const facilityNow = server.facility;
      respond(() => options.onsuccess(scheduleXml([{ title: `Boş : ${facilityNow}`, start: `${shown[0]}T08:00:00+0300`,
        end: `${shown[0]}T09:00:00+0300` }]), 'success', { status: 200, responseURL: 'https://rez.metu.edu.tr/view/home.jsf' }));
      return;
    }
    if (options.source === 'form:facility') {
      const wanted = inputs['form:facility_input'].value;
      respond(() => {
        if (facilityFailure === 'http') {
          const xhr = { status: 500, responseText: 'Internal error' };
          options.onerror?.(xhr, 'error', 'Internal Server Error');
          options.oncomplete?.(xhr, 'error');
          return;
        }
        const xhr = { status: 200, responseXML: partial({ error: facilityFailure === 'jsf', redirect: facilityFailure === 'redirect' }) };
        if (!facilityFailure) {
          server.facility = wanted;
          // Like the real site: the form update recreates the schedule in day view.
          if (recreate) {
            env.PrimeFaces.ajax.Utils?.updateElement?.('form', '<fixture form>', {});
            env.PrimeFaces.cw('Schedule', 'widget_form_myschedule', { id: 'form:myschedule', defaultView: 'agendaDay',
              ...(sundayRange ? {extender() { this.cfg.validRange = nowDate => ({start:nowDate,end:'1 Nov 2026 20:59:59 GMT'}); }} : {}) });
          }
          if (autoLoad) schedule.jqc.fullCalendar('refetchEvents');
        }
        options.oncomplete?.(xhr, 'success');
      });
    }
  };
  const schedule = {
    id: 'form:myschedule',
    jqc: { fullCalendar: (action, target) => {
      if (action === 'getView') return { name: viewName, start: { format: () => shown[0] }, end: { format: () => shown.at(-1) } };
      if (action === 'getDate') return { format: () => shown[0] };
      if (action === 'changeView') { viewName = target; env.PrimeFaces.ajax.Request.handle({ source: 'form:myschedule', onsuccess: () => true }); }
      if (action === 'gotoDate') { shown = WEEK.slice(); env.PrimeFaces.ajax.Request.handle({ source: 'form:myschedule', onsuccess: () => true }); }
      if (action === 'refetchEvents') env.PrimeFaces.ajax.Request.handle({ source: 'form:myschedule', onsuccess: () => true });
      return undefined;
    } },
    update() { this.jqc.fullCalendar('refetchEvents'); }
  };
  const field = { id: 'form:facility', selectValue(value) {
    inputs['form:facility_input'].value = value;
    env.PrimeFaces.ajax.Request.handle({ source: 'form:facility' });
  } };
  Object.assign(env, {
    location: { href: 'https://rez.metu.edu.tr/view/home.jsf', origin: 'https://rez.metu.edu.tr' },
    document: {
      body: { textContent: '' },
      querySelector: () => null,
      getElementById: id => id === 'form:myschedule_container'
        ? { querySelectorAll: () => /Week$/.test(viewName) ? shown.map(day => ({ getAttribute: () => day })) : [] }
        : inputs[id] || null
    },
    PrimeFaces: { widgets: { schedule, facility: field }, ajax: { Request: { handle: original }, Queue: { isEmpty: () => pending === 0 } },
      cw(_type, _var, cfg) {
        viewName = cfg.defaultView;
        if (sundayRange) {
          cfg.extender?.call({cfg});
          const range = cfg.validRange({format:pattern=>pattern==='YYYY-MM-DD'?'2026-11-01':'10:30:00.000'});
          const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value
            : new Date(Date.parse(value)).toISOString().slice(0,10);
          const start = typeof range.start?.format === 'function' ? range.start.format('YYYY-MM-DD') : day(range.start);
          shown = [];
          for(let stamp=Date.parse(start+'T12:00:00Z'); new Date(stamp).toISOString().slice(0,10)<day(range.end);stamp+=86400000)
            shown.push(new Date(stamp).toISOString().slice(0,10));
        } else if (cfg.defaultDate) shown = WEEK.slice();
      } },
    Date, setTimeout, clearTimeout,
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' }
  });
  return { env, requests, server, original };
}

test('a Sunday end-of-day extender keeps the last permitted day readable with one verified facility request',async()=>{
 const page=site({facility:'17',recreate:true,sundayRange:true});
 page.env.Date={now:()=>Date.parse('2026-11-01T07:30:00Z')};
 const result=await createReader(page.env).read({facilityId:'21',dates:['2026-11-01']});
 assert.equal(result.ok,true);assert.deepEqual(result.dates,['2026-11-01']);
 assert.equal(result.events[0].start,'2026-11-01T08:00:00+0300');
 assert.equal(result.stats.selectionVerified,true);assert.equal(result.actions.length,1);
 assert.equal(page.requests.filter(r=>r.source==='form:myschedule').length,1);
});

test('read date boundaries retain exclusive midnight/date-only ends and never move an invalid end forward',()=>{
 const normalize=globalThis.RezRefreshMain.normalizeReadRange;
 const now={format:p=>p==='YYYY-MM-DD'?'2026-11-01':'10:30:00.000'};
 assert.deepEqual(normalize({start:now,end:'1 Nov 2026 20:59:59 GMT'}),{start:'2026-11-01',end:'2026-11-02'});
 assert.equal(normalize({end:'2026-11-01'}).end,'2026-11-01');
 assert.equal(normalize({end:'2026-10-31T21:00:00Z'}).end,'2026-11-01');
 assert.equal(normalize({end:'2026-10-31'}).end,'2026-10-31');
 assert.equal(normalize({end:'invalid'}).end,'invalid');
 assert.equal(normalize(null),null);
});

test('replacing the calendar form disposes the old instance and keeps one live calendar over repeated reads',async()=>{
  const page=site({facility:'17',recreate:true}),pf=page.env.PrimeFaces,jqc=pf.widgets.schedule.jqc;
  const retained=new Set();let node={isConnected:true},calendar={destroy(){}},disposals=0;
  retained.add(calendar);jqc[0]=node;
  const originalCalendar=jqc.fullCalendar;
  jqc.fullCalendar=(action,...args)=>{
    if(action==='getCalendar')return calendar;
    if(action==='destroy'){retained.delete(calendar);calendar=null;disposals++;return;}
    return originalCalendar(action,...args);
  };
  const getElement=page.env.document.getElementById;
  page.env.document.getElementById=id=>id==='form'?{contains:element=>element===node}:getElement(id);
  const update=function(){node.isConnected=false;node={isConnected:true};jqc[0]=node;calendar=null;};
  pf.ajax.Utils={updateElement:update};
  const originalCw=pf.cw;
  pf.cw=function(...args){originalCw.apply(this,args);calendar={destroy(){}};retained.add(calendar);};
  const cw=pf.cw,reader=createReader(page.env);
  for(let read=0;read<30;read++){
    const result=await reader.read({facilityId:read%2?'17':'21',dates:WEEK});
    assert.equal(result.ok,true);assert.equal(result.actions.length,1,'no extra site action for cleanup');
    assert.equal(retained.size,1,'an old calendar must not keep its global handlers');
    assert.equal(pf.ajax.Utils.updateElement,update,'the temporary DOM-update hook is restored');
    assert.equal(pf.cw,cw,'the weekly setup hook is restored');
  }
  assert.equal(disposals,30);assert.equal(page.env.__rezReadStates.size,0);
});

test('calendar cleanup never destroys another component or a detached calendar',()=>{
  const clean=globalThis.RezRefreshMain.disposeScheduleForUpdate;
  let destroyed=0;const node={isConnected:true},instance={destroy(){}},jqc={0:node,fullCalendar(action){if(action==='getCalendar')return instance;if(action==='destroy')destroyed++;}};
  const env={document:{getElementById:id=>id==='form'?{contains:()=>true}:id==='other'?{contains:()=>false}:null},PrimeFaces:{widgets:{calendar:{id:'form:myschedule',jqc}}}};
  assert.equal(clean(env,'other'),false);assert.equal(clean(env,'javax.faces.ViewState'),false);assert.equal(destroyed,0);
  node.isConnected=false;assert.equal(clean(env,'form'),false);assert.equal(destroyed,0);
  node.isConnected=true;assert.equal(clean(env,'form'),true);assert.equal(destroyed,1);
});

test('aborting a read restores the DOM-update hook as well as the request and weekly hooks',()=>{
  const page=site({facility:'17'}),update=()=>{};page.env.PrimeFaces.ajax.Utils={updateElement:update};
  const cw=page.env.PrimeFaces.cw,reader=createReader(page.env),token='abcdef12-0000-4000-8000-000000000001';
  reader.step({token,facilityId:'21',dates:WEEK});
  assert.notEqual(page.env.PrimeFaces.ajax.Utils.updateElement,update);
  reader.abort({token});assert.equal(page.env.PrimeFaces.ajax.Utils.updateElement,update);
  assert.equal(page.env.PrimeFaces.ajax.Request.handle,page.original);assert.equal(page.env.PrimeFaces.cw,cw);
});

test('a verified facility change reuses the schedule load it triggered: one site action, no duplicate refresh', async () => {
  const page = site({ facility: '17' });
  const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
  assert.equal(result.ok, true);
  assert.equal(result.facilityId, '21');
  assert.equal(result.events[0].title, 'Boş : 21');
  assert.deepEqual(page.requests.map(r => r.source), ['form:facility', 'form:myschedule']);
  assert.equal(result.actions.length, 1);
  assert.equal(result.stats.reused, true);
  assert.equal(result.stats.selectionVerified, true);
  assert.equal(page.env.PrimeFaces.ajax.Request.handle, page.original);
});

test('without a triggered load the reader makes one normal refresh, at least one second after the selection', async () => {
  const page = site({ facility: '17', autoLoad: false });
  const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
  assert.equal(result.ok, true);
  assert.equal(result.events[0].title, 'Boş : 21');
  assert.deepEqual(page.requests.map(r => r.source), ['form:facility', 'form:myschedule']);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions[1] - result.actions[0] >= 1000);
  assert.equal(result.stats.reused, false);
});

test('a failed facility change never labels the previous facility’s calendar with the new facility', async () => {
  for (const failure of ['http', 'jsf']) {
    const page = site({ facility: '17', facilityFailure: failure });
    const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
    assert.equal(result.ok, false, failure);
    assert.equal(result.reason, 'unverified_response');
    assert.equal(page.server.facility, '17');
    assert.deepEqual(page.requests.map(r => r.source), ['form:facility']);
  }
});

test('a redirect during facility selection is a session expiry, not availability', async () => {
  const page = site({ facility: '17', facilityFailure: 'redirect' });
  const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
  assert.equal(result.reason, 'login_required');
  assert.equal(page.requests.filter(r => r.source === 'form:myschedule').length, 0);
});

test('an already selected facility needs only one verified refresh', async () => {
  const page = site({ facility: '21' });
  const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
  assert.equal(result.ok, true);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(page.requests.map(r => r.source), ['form:myschedule']);
});

test('a day view is switched to the week and the week load is the proof, with actions spaced by the budget', async () => {
  const page = site({ facility: '21', view: 'agendaDay' });
  const result = await createReader(page.env).read({ mode: 'read', facilityId: '21', dates: WEEK });
  assert.equal(result.ok, true);
  assert.equal(result.viewType, 'week');
  assert.deepEqual(result.dates, WEEK);
  assert.ok(result.actions.length <= 2);
  for (let i = 1; i < result.actions.length; i++) assert.ok(result.actions[i] - result.actions[i - 1] >= 1000);
});

test('invalid read requests do not touch the site', async () => {
  const page = site();
  for (const request of [{ facilityId: 'x', dates: WEEK }, { facilityId: '21', dates: [] }, { facilityId: '21', unitId: 'a', dates: WEEK }]) {
    const result = await createReader(page.env).read({ mode: 'read', ...request });
    assert.equal(result.reason, 'invalid_capture_payload');
  }
  assert.equal(page.requests.length, 0);
});

test('the reader reports, with digits masked, which event titles are not free-place counts',async()=>{
 const page=site({facility:'21'});
 const original=page.env.PrimeFaces.ajax.Request.handle;
 page.env.PrimeFaces.ajax.Request.handle=function(options){
  if(options.source!=='form:myschedule')return original.call(this,options);
  const update={getAttribute:n=>n==='id'?'form:myschedule':null,textContent:JSON.stringify({events:[
   {title:'Boş : 3',start:`${WEEK[0]}T08:00:00+0300`,end:`${WEEK[0]}T09:00:00+0300`},
   {title:'Dolu 12/12',start:`${WEEK[0]}T10:00:00+0300`,end:`${WEEK[0]}T11:00:00+0300`}]})};
  setTimeout(()=>options.onsuccess({documentElement:{localName:'partial-response'},getElementsByTagName:n=>n==='update'?[update]:[]},'success',{status:200}),5);
 };
 const result=await createReader(page.env).read({mode:'read',facilityId:'21',dates:WEEK});
 assert.equal(result.ok,true);
 assert.equal(result.stats.events,2);assert.equal(result.stats.otherEvents,1);
 assert.deepEqual(result.stats.otherTitles,['Dolu #/#']);
});

test('page steps never use the page’s own timers, so a throttled background tab cannot stall a read',async()=>{
 const page=site({facility:'17',autoLoad:false});
 page.env.setTimeout=()=>{throw new Error('page timer used');};
 const reader=createReader(page.env),token='0f0e0d0c-0b0a-4909-8807-060504030201';let result,calls=0;
 for(;;){
  const step=reader.step({mode:'read-step',token,facilityId:'21',dates:WEEK,minGapMs:1000});calls++;
  if(step.done){result=step.result;break;}
  assert.ok(step.retryAfterMs>0&&step.retryAfterMs<=1000);
  await new Promise(r=>setTimeout(r,step.retryAfterMs));
 }
 assert.equal(result.ok,true);assert.equal(result.facilityId,'21');assert.equal(result.actions.length,2);
 assert.ok(result.actions[1]-result.actions[0]>=1000);assert.ok(calls>=3);
 assert.equal(page.env.PrimeFaces.ajax.Request.handle,page.original,'the hook is removed when the read ends');
});
test('an abandoned read is aborted and its page hook removed before the next one starts',()=>{
 const page=site({facility:'17'});const reader=createReader(page.env);
 const first=reader.step({mode:'read-step',token:'aaaaaaaa-0000-4000-8000-000000000001',facilityId:'21',dates:WEEK});
 assert.equal(first.done,false);assert.notEqual(page.env.PrimeFaces.ajax.Request.handle,page.original);
 const aborted=reader.abort({token:'aaaaaaaa-0000-4000-8000-000000000001'});
 assert.equal(aborted.result.reason,'timeout');assert.equal(aborted.result.actions.length,1);
 assert.equal(page.env.PrimeFaces.ajax.Request.handle,page.original);
});

test('the recreated schedule opens directly as the wanted week: one site action and no view switch',async()=>{
 const page=site({facility:'17',recreate:true});const originalCw=page.env.PrimeFaces.cw;
 const result=await createReader(page.env).read({mode:'read',facilityId:'21',dates:WEEK});
 assert.equal(result.ok,true);assert.equal(result.events[0].title,'Boş : 21');
 assert.equal(result.actions.length,1);assert.equal(result.stats.weekDefault,true);assert.equal(result.stats.reused,true);
 assert.deepEqual(page.requests.map(r=>r.source),['form:facility','form:myschedule']);
 assert.equal(page.env.PrimeFaces.cw,originalCw,'the widget hook is removed afterwards');
});
test('if the site ignores the week setting, the reader still switches to the week with a second action',async()=>{
 const page=site({facility:'17',recreate:true});const forced=page.env.PrimeFaces.cw;
 page.env.PrimeFaces.cw=function(type,widgetVar,cfg){return forced.call(this,type,widgetVar,{...cfg,defaultView:'agendaDay',defaultDate:undefined});};
 const result=await createReader(page.env).read({mode:'read',facilityId:'21',dates:WEEK});
 assert.equal(result.ok,true);assert.equal(result.viewType,'week');assert.equal(result.events[0].title,'Boş : 21');
 assert.equal(result.actions.length,2);assert.ok(result.actions[1]-result.actions[0]>=1000);
});
