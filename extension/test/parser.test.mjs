import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../parser.js';

const { extract, extractFreshEvents } = globalThis.RezCalendarParser;
const URL = 'https://rez.metu.edu.tr/view/home.jsf';
const NOW = new Date('2026-10-18T08:30:00.000Z');

function element({ content = '', className = '', attrs = {}, children = {}, all = {} } = {}) {
  return {
    textContent: content,
    className,
    value: attrs.value,
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (selector) => children[selector] ?? null,
    querySelectorAll: (selector) => all[selector] ?? [],
    getClientRects: () => [1],
    closest: () => null
  };
}

function page({ date = '2026-10-18', day = true, eventText = '11:00 - 12:45 Boş: 2',
  time = '11:00 - 12:45', title = 'Boş: 2', dates = [date], facilityId = '17', eventStart = null } = {}) {
  const event = element({
    content: eventText,
    attrs: eventStart ? { 'data-start': eventStart } : {},
    children: {
      '.fc-title': element({ content: title }),
      '.fc-time': element({ content: time })
    }
  });
  const view = element({
    className: day ? 'fc-agendaDay-view fc-view' : 'fc-agendaWeek-view fc-view',
    all: {
      '[data-date]': dates.map((item) => element({ attrs: { 'data-date': item } })),
      '.fc-event': [event]
    }
  });
  return {
    body: element({ content: 'Tesislerin Doluluk Durumu' }),
    getElementById: (id) => id === 'form:facility_input'
      ? element({ attrs: { value: facilityId } })
      : id === 'form:facility_label'
        ? element({ content: 'Baraka Spor Salonu - Fitness Salonu' }) : null,
    querySelector: (selector) => selector === '.fc-view' ? view : null
  };
}

test('reads only an explicitly dated day and marks passive DOM as stale', () => {
  const result = extract(page(), URL, NOW);
  assert.equal(result.state, 'ok');
  assert.equal(result.fresh, false);
  assert.deepEqual(result.facility, { id: '17', label: 'Baraka Spor Salonu - Fitness Salonu' });
  assert.deepEqual(result.view, { type: 'day', date: '2026-10-18' });
  assert.deepEqual(result.slots, [{
    date: '2026-10-18', start: '11:00', end: '12:45', free: 2
  }]);
});

test('does not assign a date to a week view', () => {
  const result = extract(page({ day: false, dates: ['2026-10-18', '2026-10-19'] }), URL, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.equal(result.view.type, 'week');
  assert.deepEqual(result.slots, []);
});

test('rejects an event if its time cannot be read', () => {
  const result = extract(page({ time: 'unknown' }), URL, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.deepEqual(result.slots, []);
});

test('rejects a vacancy if its end time is missing', () => {
  const result = extract(page({ time: '11:00' }), URL, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.deepEqual(result.slots, []);
});

test('preserves an explicit zero vacancy as evidence for that session', () => {
  const result = extract(page({ title: 'Boş: 0' }), URL, NOW);
  assert.equal(result.state, 'ok');
  assert.deepEqual(result.slots, [{ date: '2026-10-18', start: '11:00', end: '12:45', free: 0 }]);
});

test('rejects an invalid time range before posting to the local service', () => {
  const result = extract(page({ time: '12:45 - 11:00' }), URL, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.deepEqual(result.slots, []);
});

test('rejects a calendar without a selected facility or explicit date', () => {
  assert.equal(extract(page({ facilityId: '' }), URL, NOW).state, 'calendar_unavailable');
  assert.equal(extract(page({ dates: [] }), URL, NOW).state, 'calendar_unavailable');
});

test('accepts an explicit ISO date on a visible day event when day cells omit it', () => {
  const result = extract(page({ dates: [], eventStart: '2026-10-18T11:00:00' }), URL, NOW);
  assert.equal(result.state, 'ok');
  assert.equal(result.view.date, '2026-10-18');
  assert.equal(result.fresh, false);
});

test('does not read a login page as a calendar', () => {
  const result = extract(page(), 'https://rez.metu.edu.tr/', NOW);
  assert.equal(result.state, 'login_required');
  assert.deepEqual(result.slots, []);
});

test('only verified AJAX events can become fresh; UTC event times become ODTÜ local time', () => {
  const result = extractFreshEvents(page({ dates: [] }), URL, {
    date: '2026-10-18', facilityId: '17', refreshId: '123e4567-e89b-42d3-a456-426614174000',
    events: [{ title: 'Boş : 2', start: '2026-10-18T08:00:00+0000',
      end: '2026-10-18T09:45:00+0000', allDay: false }]
  }, NOW);
  assert.equal(result.state, 'ok');
  assert.equal(result.fresh, true);
  assert.equal(result.refresh_id, '123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(result.slots, [{ date: '2026-10-18', start: '11:00', end: '12:45', free: 2 }]);
});

test('fresh response is rejected when facility or visible day differs', () => {
  const evidence = {
    date: '2026-10-18', facilityId: '17', refreshId: '123e4567-e89b-42d3-a456-426614174000', events: []
  };
  assert.equal(extractFreshEvents(page({ facilityId: '4' }), URL, evidence, NOW).fresh, false);
  assert.equal(extractFreshEvents(page({ date: '2026-10-19' }), URL, evidence, NOW).state,
    'calendar_unavailable');
  assert.equal(extractFreshEvents(page({ day: false }), URL, evidence, NOW).fresh, false);
});

test('a malformed availability event suppresses the entire fresh observation', () => {
  const result = extractFreshEvents(page(), URL, {
    date: '2026-10-18', facilityId: '17', refreshId: '123e4567-e89b-42d3-a456-426614174000',
    events: [{ title: 'Boş : 2', start: '2026-10-18T08:00:00+0000', end: 'wrong' }]
  }, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.equal(result.fresh, false);
  assert.deepEqual(result.slots, []);
});

test('a changed title cannot turn a nonempty AJAX response into a fresh empty calendar', () => {
  const result = extractFreshEvents(page(), URL, {
    date: '2026-10-18', facilityId: '17', refreshId: '123e4567-e89b-42d3-a456-426614174000',
    events: [{ title: 'Available: 2', start: '2026-10-18T08:00:00+0000',
      end: '2026-10-18T09:45:00+0000', allDay: false }]
  }, NOW);
  assert.equal(result.state, 'calendar_unavailable');
  assert.equal(result.fresh, false);
  assert.deepEqual(result.slots, []);
});

test('a recognized zero-capacity event retains its explicit session identity', () => {
  const result = extractFreshEvents(page(), URL, {
    date: '2026-10-18', facilityId: '17', refreshId: '123e4567-e89b-42d3-a456-426614174000',
    events: [{ title: 'Boş: 0', start: '2026-10-18T08:00:00+0000',
      end: '2026-10-18T09:45:00+0000', allDay: false }]
  }, NOW);
  assert.equal(result.state, 'ok');
  assert.equal(result.fresh, true);
  assert.deepEqual(result.slots, [{ date: '2026-10-18', start: '11:00', end: '12:45', free: 0 }]);
});

test('verified weekly responses split dates in Istanbul time and reject outside-range events', () => {
  const dates = ['2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18'];
  const doc = page({ day: false, dates });
  const evidence = { ok: true, viewType: 'week', facilityId: '17', dates,
    refreshId: '123e4567-e89b-42d3-a456-426614174000',
    events: [{ title: 'Boş: 2', start: '2026-10-16T13:00:00Z', end: '2026-10-16T14:30:00Z' }] };
  const results = globalThis.RezCalendarParser.extractFreshWeek(doc, URL, evidence, NOW);
  assert.equal(results.length, 7);
  assert.equal(results[4].view.date, '2026-10-16');
  assert.equal(results[4].slots[0].start, '16:00');
  assert.equal(results[3].slots.length, 0);
  const bad = { ...evidence, events: [{...evidence.events[0], start:'2026-10-19T13:00:00Z', end:'2026-10-19T14:30:00Z'}] };
  assert.equal(globalThis.RezCalendarParser.extractFreshWeek(doc, URL, bad, NOW), null);
  assert.equal(globalThis.RezCalendarParser.extractFreshWeek(page({day:true}), URL, evidence, NOW), null);
});

test('a clipped week only emits enabled days, including explicitly empty requested dates', () => {
  const dates=['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
  const evidence={ok:true,viewType:'week',facilityId:'17',dates,
    refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[]};
  const snapshots=globalThis.RezCalendarParser.extractFreshWeek(page({day:false,dates}),URL,evidence,NOW);
  assert.deepEqual(snapshots.map(item=>item.view.date),dates);
  assert(snapshots.every(item=>item.fresh&&item.slots.length===0));
});

test('today in a disabled column does not invalidate the requested future days of the same week', () => {
  const dates=['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
  const evidence={ok:true,viewType:'week',facilityId:'17',dates,
    refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[
      {title:'Boş : 1',start:'2026-10-27T16:30:00Z',end:'2026-10-27T18:00:00Z'},
      {title:'Boş : 2',start:'2026-10-30T13:00:00Z',end:'2026-10-30T14:30:00Z'}]};
  const result=globalThis.RezCalendarParser.extractFreshWeek(page({day:false,dates}),URL,evidence,NOW);
  assert.equal(result.length,5);
  assert.equal(result[2].slots[0].start,'16:00');
  assert.equal(result.flatMap(x=>x.slots).length,1);
});

test('explicit AJAX proof can read a clipped current day but cannot relabel a past or future disabled day',()=>{
 const now=new Date('2026-10-28T00:01:00Z');
 const enabled=['2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
 const doc=page({day:false,dates:enabled});
 const evidence={ok:true,viewType:'week',facilityId:'17',dates:['2026-10-28',...enabled],clippedDate:'2026-10-28',
  refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[{title:'Boş: 2',start:'2026-10-28T13:00:00Z',end:'2026-10-28T14:30:00Z'}]};
 const snapshots=globalThis.RezCalendarParser.extractFreshWeek(doc,URL,evidence,now);
 assert.equal(snapshots.length,5);assert.equal(snapshots[0].slots[0].start,'16:00');
 assert.equal(globalThis.RezCalendarParser.extractFreshWeek(doc,URL,{...evidence,clippedDate:undefined},now),null);
 assert.equal(globalThis.RezCalendarParser.extractFreshWeek(doc,URL,evidence,new Date('2026-10-29T00:01:00Z')),null);
});

test('one-week-old end date is accepted only with a recent independent official session definition',()=>{
 const now=new Date('2026-10-28T00:00:00Z');
 const dates=['2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
 const doc=page({day:false,dates:dates.slice(1)});
 const base={ok:true,viewType:'week',facilityId:'17',date:dates[0],dates,clippedDate:dates[0],
  refreshId:'123e4567-e89b-42d3-a456-426614174000',
  events:[{title:'Boş: 10',start:'2026-10-28T08:00:00+0300',end:'2026-10-21T09:30:00+0300',allDay:false}]};
 const parse=e=>globalThis.RezCalendarParser.extractFreshWeek(doc,URL,e,now);
 assert.equal(parse(base),null);
 const definition={source:'official-booking-form',verifiedAt:'2026-10-27T22:31:00Z',sessions:[{start:'08:00',end:'09:30'}]};
 const good={...base,sessionCatalog:{'17|2026-10-28':definition}};
 const snapshots=parse(good);assert.equal(snapshots.length,5);
 assert.deepEqual(snapshots[0].slots,[{date:'2026-10-28',start:'08:00',end:'09:30',free:10}]);
 assert.equal(parse({...good,sessionCatalog:{'21|2026-10-28':definition}}),null);
 assert.equal(parse({...good,sessionCatalog:{'17|2026-10-28':{...definition,verifiedAt:'2026-10-26T00:00:00Z'}}}),null);
 assert.equal(parse({...good,sessionCatalog:{'17|2026-10-28':{...definition,sessions:[{start:'08:30',end:'09:30'}]}}}),null);
 assert.equal(parse({...good,events:[{...base.events[0],end:'2026-10-20T09:30:00+0300'}]}),null);
 assert.equal(parse({...good,events:[{...base.events[0],end:'2026-10-21T09:30:00+0300',allDay:true}]}),null);
});

test('an invalid end in an excluded past day cannot block valid enabled days after midnight',()=>{
 const dates=['2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
 const evidence={ok:true,viewType:'week',facilityId:'17',date:dates[0],dates,refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[
  {title:'Boş: 5',start:'2026-10-28T08:00:00+0300',end:'2026-10-21T09:30:00+0300'},
  {title:'Boş: 2',start:'2026-10-30T17:00:00+0300',end:'2026-10-30T18:45:00+0300'}]};
 const result=globalThis.RezCalendarParser.extractFreshWeek(page({day:false,dates}),URL,evidence,new Date('2026-10-29T00:00:00Z'));
 assert.equal(result.length,4);assert.deepEqual(result[1].slots,[{date:'2026-10-30',start:'17:00',end:'18:45',free:2}]);
});


test('partial week quarantines only the time-invalid day and preserves all provenance gates',()=>{
 const dates=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'];
 const now=new Date('2026-11-01T19:15:00Z'),doc=page({day:false,dates,facilityId:'48'});
 const e={ok:true,viewType:'week',facilityId:'48',dates,date:dates[0],refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[{title:'Boş:1',start:dates[0]+'T20:00:00+0300',end:dates[0]+'T20:00:00+0300'},{title:'Boş:1',start:dates[1]+'T14:00:00+0300',end:dates[1]+'T15:00:00+0300'}]};
 const parse=(x=e,d=doc)=>globalThis.RezCalendarParser.extractFreshWeek(d,URL,x,now,true);
 assert.equal(globalThis.RezCalendarParser.extractFreshWeek(doc,URL,e,now),null);
 const result=parse();assert.deepEqual(result.rejectedDates,[dates[0]]);assert.equal(result.snapshots.length,6);assert(!result.snapshots.some(s=>s.view.date===dates[0]));assert.equal(result.snapshots[0].slots[0].end,'15:00');assert(result.snapshots.slice(1).every(s=>s.fresh&&s.slots.length===0));
 for(const start of ['bad','2026-11-09T20:00:00+0300'])assert.equal(parse({...e,events:[{...e.events[0],start}]}),null);
 assert.equal(parse(e,page({day:false,dates:dates.slice(1),facilityId:'48'})),null);
 assert.equal(parse(e,page({day:false,dates,facilityId:'17'})),null);
 assert.equal(parse({...e,events:dates.map(date=>({title:'Boş:1',start:date+'T20:00:00+0300',end:date+'T20:00:00+0300'}))}),null);
});
test('new-week Baraka correction requires its newly verified same-day official session',()=>{
 const dates=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'],now=new Date('2026-11-01T19:15:00Z');
 const e={ok:true,viewType:'week',facilityId:'17',dates,date:dates[0],refreshId:'123e4567-e89b-42d3-a456-426614174000',events:[{title:'Boş:45',start:'2026-11-04T08:00:00+0300',end:'2026-10-28T09:30:00+0300'}],sessionCatalog:{'17|2026-11-04':{source:'official-booking-form',verifiedAt:'2026-11-01T19:13:46Z',sessions:[{start:'08:00',end:'09:30'}]}}};
 const result=globalThis.RezCalendarParser.extractFreshWeek(page({day:false,dates}),URL,e,now);assert.equal(result.length,7);assert.equal(result[2].slots[0].end,'09:30');
});
