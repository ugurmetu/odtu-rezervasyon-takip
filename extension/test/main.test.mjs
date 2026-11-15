import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import '../main.js';

const { createController, parseScheduleResponse } = globalThis.RezRefreshMain;
const mainSource = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

function scheduleXml(events = []) {
  const content = JSON.stringify({ events });
  const update = { getAttribute: (name) => name === 'id' ? 'form:myschedule' : null,
    textContent: content };
  return {
    documentElement: { localName: 'partial-response' },
    getElementsByTagName: (name) => name === 'update' ? [update] : []
  };
}

function page({ response = scheduleXml([]), status = 'success', httpStatus = 200,
  day = '2026-10-18', facility = '17', view = 'agendaDay', useErrorCallback = false,
  throwSuccess = false, responseText = '', rangeStart = null, rangeEnd = null } = {}) {
  let calls = 0;
  let selectedDay = day;
  const navigations = [];
  let now = Date.parse('2026-10-18T08:00:00Z');
  const widget = {
    id: 'form:myschedule',
    jqc: { fullCalendar: (action, target) => {
      if (action === 'getView') return { name: view, start: { format: () => rangeStart || selectedDay },
        end: { format: () => rangeEnd } };
      if (action === 'getDate') return { format: () => selectedDay };
      if (action === 'gotoDate') {
        navigations.push(target);
        selectedDay = target;
      }
      if (action === 'refetchEvents') {
        env.PrimeFaces.ajax.Request.handle({
          source: 'form:myschedule',
          onsuccess: () => {
            if (throwSuccess) throw new Error('site callback failed');
            return true;
          }
        });
      }
      return undefined;
    } },
    update() { this.jqc.fullCalendar('refetchEvents'); }
  };
  const original = function (options) {
    calls += 1;
    queueMicrotask(() => {
      const xhr = { status: httpStatus, responseText,
        responseURL: 'https://rez.metu.edu.tr/view/home.jsf' };
      if (useErrorCallback) options.onerror(xhr, 'error', 'site error');
      else options.onsuccess(response, status, xhr);
    });
  };
  const env = {
    location: { href: 'https://rez.metu.edu.tr/view/home.jsf', origin: 'https://rez.metu.edu.tr' },
    document: {
      querySelector: () => null,
      getElementById: (id) => id === 'form:facility_input' ? { value: facility } : null
    },
    PrimeFaces: { widgets: { schedule: widget }, ajax: { Request: { handle: original } } },
    Date: { now: () => now },
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
    setTimeout, clearTimeout
  };
  return { env, original, navigations, get calls() { return calls; },
    get selectedDay() { return selectedDay; }, advance(ms) { now += ms; } };
}

test('one-shot MAIN injection returns evidence directly without a page message event', async () => {
  const fixture = page();
  fixture.env.postMessage = () => { throw new Error('page messages are forbidden'); };
  fixture.env.addEventListener = () => { throw new Error('page event channel is forbidden'); };
  const result = await runInNewContext(mainSource, { window: fixture.env });
  assert.equal(result.ok, true);
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.env.RezRefreshMain, undefined);
});

test('one selected day refresh uses site widget and a verified schedule partial response', async () => {
  const fixture = page({ response: scheduleXml([{ title: 'Boş : 2',
    start: '2026-10-18T08:00:00+0000', end: '2026-10-18T09:45:00+0000' }]) });
  const controller = createController(fixture.env);
  const result = await controller.refresh();
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.env.PrimeFaces.ajax.Request.handle, fixture.original);
  assert.equal(result.ok, true);
  assert.equal(result.date, '2026-10-18');
  assert.equal(result.facilityId, '17');
  assert.equal(result.events.length, 1);
  assert.equal((await controller.refresh()).reason, 'rate_limited');
  assert.equal(fixture.calls, 1);
  fixture.advance(60_000);
  assert.equal((await controller.refresh()).ok, true);
  assert.equal(fixture.calls, 2);
});

test('403 or a 200 HTML login page never proves freshness', async () => {
  const denied = page({ httpStatus: 403 });
  assert.equal((await createController(denied.env).refresh()).reason, 'site_access_denied');
  const limited = page({ httpStatus: 429, useErrorCallback: true });
  assert.equal((await createController(limited.env).refresh()).reason, 'site_rate_limited');
  const deniedWithSiteFailure = page({ httpStatus: 403, throwSuccess: true });
  assert.equal((await createController(deniedWithSiteFailure.env).refresh()).reason, 'site_access_denied');
  const html = page({ response: { documentElement: { localName: 'html' },
    getElementsByTagName: () => [] } });
  assert.equal((await createController(html.env).refresh()).ok, false);
  const disguisedBlock = page({ response: { documentElement: { localName: 'html' },
    getElementsByTagName: () => [] },
  responseText: '<h1>Access Denied. Automated abuse, scraping, or malicious behavior</h1>' });
  assert.equal((await createController(disguisedBlock.env).refresh()).reason, 'site_access_denied');
});

test('an expired AJAX login response is classified without treating it as fresh', async () => {
  const redirect = page({ response: { documentElement: { localName: 'partial-response' },
    getElementsByTagName: (name) => name === 'redirect' ? [{}] : [] } });
  assert.equal((await createController(redirect.env).refresh()).reason, 'login_required');

  const html = page({ response: { documentElement: { localName: 'html' },
    getElementsByTagName: () => [] },
  responseText: '<html><form><input name="password" type="password"></form></html>' });
  assert.equal((await createController(html.env).refresh()).reason, 'login_required');

  const parsedHtml = page({ response: { documentElement: { localName: 'html' },
    getElementsByTagName: () => [], querySelector: () => ({}) } });
  assert.equal((await createController(parsedHtml.env).refresh()).reason, 'login_required');

  const unauthorized = page({ httpStatus: 401, useErrorCallback: true });
  assert.equal((await createController(unauthorized.env).refresh()).reason, 'login_required');
});

test('a full-page explicit abuse denial stops before the schedule widget is called', async () => {
  const blocked = page();
  blocked.env.document.body = { textContent:
    'Access Denied. Automated abuse, scraping, or malicious behavior' };
  blocked.env.PrimeFaces = undefined;
  assert.equal((await createController(blocked.env).refresh()).reason, 'site_access_denied');
  assert.equal(blocked.calls, 0);
});

test('an expired selected day moves forward once and only the next gated attempt verifies it', async () => {
  const expired = page({ day: '2026-10-17' });
  const controller = createController(expired.env);
  assert.equal((await controller.refresh()).reason, 'calendar_day_advanced');
  assert.deepEqual(expired.navigations, ['2026-10-18']);
  assert.equal(expired.calls, 0);
  assert.equal((await controller.refresh()).reason, 'rate_limited');
  expired.advance(60_000);
  assert.equal((await controller.refresh()).ok, true);
  assert.equal(expired.calls, 1);

  const future = page({ day: '2026-10-19' });
  assert.equal((await createController(future.env).refresh()).ok, true);
  assert.deepEqual(future.navigations, []);
});

test('crossing Istanbul midnight invalidates an old-day response before the next day is selected', async () => {
  const crossing = page({ day: '2026-10-19' });
  crossing.advance(Date.parse('2026-10-19T20:59:59Z') - Date.parse('2026-10-18T08:00:00Z'));
  const result = createController(crossing.env).refresh();
  crossing.advance(2_000);
  assert.equal((await result).reason, 'unverified_response');
  assert.equal(crossing.calls, 1);
  assert.equal((await createController(crossing.env).refresh()).reason, 'calendar_day_advanced');
  assert.deepEqual(crossing.navigations, ['2026-10-20']);
  assert.equal(crossing.calls, 1);
});

test('Sunday 21:00 Istanbul advances to Monday without a second schedule update', async () => {
  const fixture = page();
  const controller = createController(fixture.env);
  fixture.advance(Date.parse('2026-10-18T17:59:00Z') - Date.parse('2026-10-18T08:00:00Z'));
  assert.equal((await controller.refresh()).ok, true);
  fixture.advance(60_000);
  assert.equal((await controller.refresh()).reason, 'calendar_day_advanced');
  assert.deepEqual(fixture.navigations, ['2026-10-19']);
  assert.equal(fixture.calls, 1);
  fixture.advance(60_000);
  const monday = await controller.refresh();
  assert.equal(monday.ok, true);
  assert.equal(monday.date, '2026-10-19');
  assert.equal(fixture.calls, 2);
});

test('the Monday selected on Sunday evening stays selected across Istanbul midnight', async () => {
  const fixture = page({ day: '2026-10-19' });
  const controller = createController(fixture.env);
  fixture.advance(Date.parse('2026-10-18T20:59:59Z') - Date.parse('2026-10-18T08:00:00Z'));
  assert.equal((await controller.refresh()).date, '2026-10-19');
  fixture.advance(60_000);
  assert.equal((await controller.refresh()).date, '2026-10-19');
  assert.deepEqual(fixture.navigations, []);
  assert.equal(fixture.calls, 2);
});

test('failed day navigation never reads the stale calendar as fresh', async () => {
  const fixture = page({ day: '2026-10-17' });
  const calendar = fixture.env.PrimeFaces.widgets.schedule.jqc;
  const original = calendar.fullCalendar;
  calendar.fullCalendar = (action, ...args) => {
    if (action === 'gotoDate') throw new Error('site rejected navigation');
    return original(action, ...args);
  };
  const result = await createController(fixture.env).refresh();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'calendar_day_advance_failed');
  assert.equal(fixture.calls, 0);
});

test('missing weekly range or facility makes no request', async () => {
  const week = page({ view: 'agendaWeek' });
  assert.equal((await createController(week.env).refresh()).reason, 'calendar_date_unavailable');
  assert.equal(week.calls, 0);
  const noFacility = page({ facility: '' });
  assert.equal((await createController(noFacility.env).refresh()).reason, 'facility_not_selected');
  assert.equal(noFacility.calls, 0);
});

test('site context failures produce fixed codes without a schedule request', async () => {
  const missingPf = page();
  delete missingPf.env.PrimeFaces.ajax.Request.handle;
  assert.equal((await createController(missingPf.env).refresh()).reason, 'primefaces_unavailable');
  assert.equal(missingPf.calls, 0);

  const missingWidget = page();
  missingWidget.env.PrimeFaces.widgets = {};
  assert.equal((await createController(missingWidget.env).refresh()).reason, 'schedule_widget_missing');
  assert.equal(missingWidget.calls, 0);

  const unusableWidget = page();
  delete unusableWidget.env.PrimeFaces.widgets.schedule.update;
  assert.equal((await createController(unusableWidget.env).refresh()).reason, 'schedule_widget_unusable');
  assert.equal(unusableWidget.calls, 0);

  const login = page();
  login.env.document.querySelector = () => ({});
  assert.equal((await createController(login.env).refresh()).reason, 'login_form_present');
  assert.equal(login.calls, 0);

  const wrongPage = page();
  wrongPage.env.location.href = 'https://rez.metu.edu.tr/view/other.jsf';
  assert.equal((await createController(wrongPage.env).refresh()).reason, 'unexpected_page');
  assert.equal(wrongPage.calls, 0);
});

test('schedule update must have exact source and JSON events', () => {
  const response = scheduleXml([]);
  assert.deepEqual(parseScheduleResponse(response, 'success', { status: 200 }), []);
  assert.equal(parseScheduleResponse(response, 'success', { status: 429 }), null);
  assert.equal(parseScheduleResponse({ documentElement: { localName: 'partial-response' },
    getElementsByTagName: (name) => name === 'redirect' ? [{}] : [] }, 'success', { status: 200 }), null);
});

test('weekly AJAX evidence carries the verified seven-day range without relabeling it as one day', async () => {
  const fixture = page({ view: 'agendaWeek', rangeStart: '2026-10-12', rangeEnd: '2026-10-19' });
  const result = await createController(fixture.env).refresh();
  assert.equal(result.ok, true);
  assert.equal(result.viewType, 'week');
  assert.equal(result.dates.length, 7);
  assert.equal(result.dates[0], '2026-10-12');
  assert.equal(result.dates[6], '2026-10-18');
  assert.equal(fixture.calls, 1);
  const invalid = page({ view: 'agendaWeek', rangeStart: '2026-10-12', rangeEnd: '2026-10-20' });
  assert.equal((await createController(invalid.env).refresh()).reason, 'calendar_date_mismatch');
  assert.equal(invalid.calls, 0);
});

test('a current-time validRange cannot hide today from the weekly reader, while past anchors stay excluded',async()=>{
 const run=async day=>{
  const f=page({day,view:'agendaWeek',rangeStart:'2026-10-26',rangeEnd:'2026-11-02'});
  f.env.Date.now=()=>Date.parse('2026-10-28T00:01:00Z');
  const original=f.env.document.getElementById;
  f.env.document.getElementById=id=>id==='form:myschedule_container'
   ?{querySelectorAll:()=>['2026-10-29','2026-10-30','2026-10-31','2026-11-01'].map(date=>({getAttribute:()=>date}))}:original(id);
  return createController(f.env).refresh();
 };
 const current=await run('2026-10-28');assert.equal(current.ok,true);assert.equal(current.dates[0],'2026-10-28');
 assert.equal(current.dates.length,5);
 const old=await run('2026-10-27');assert.equal(old.ok,true);assert.equal(old.dates.includes('2026-10-27'),false);
});
