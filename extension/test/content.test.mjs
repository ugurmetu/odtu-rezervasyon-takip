import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

test('isolated parser listener can be reinjected without duplicate responders', () => {
  const listeners = new Set();
  const chrome = { runtime: { onMessage: {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); }
  } } };
  const parsed = { schema: 1, source: 'rez-calendar-extension', state: 'ok', fresh: true,
    refresh_id: '123e4567-e89b-42d3-a456-426614174000', slots: [] };
  const context = createContext({ chrome, document: {}, location: { href: 'https://rez.metu.edu.tr/view/home.jsf' },
    RezCalendarParser: { extract: () => ({ state: 'ok' }), extractFreshEvents: () => parsed } });
  const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  runInContext(source, context);
  runInContext(source, context);
  assert.equal(listeners.size, 1);
  let reply;
  [...listeners][0]({ type: 'rez:parse', evidence: { ok: true } }, {}, value => { reply = value; });
  assert.equal(reply, parsed);
});

test('official session definitions enter the parser only from the extension message, never page evidence',()=>{
 let listener,received;
 const catalog={'17|2026-10-28':{source:'official-booking-form',verifiedAt:'2026-10-27T22:31:00Z',sessions:[{start:'08:00',end:'09:30'}]}};
 const context=createContext({chrome:{runtime:{onMessage:{addListener:l=>listener=l,removeListener(){}}}},document:{},location:{href:'https://rez.metu.edu.tr/view/home.jsf'},RezCalendarParser:{extract:()=>({state:'ok'}),extractFreshWeek:(_d,_u,e)=>{received=e;return [{state:'ok'}];}}});
 runInContext(readFileSync(new URL('../content.js',import.meta.url),'utf8'),context);
 listener({type:'rez:parse',evidence:{ok:true,viewType:'week',sessionCatalog:{injected:'untrusted'}}}, {},()=>{});
 assert.equal(received.sessionCatalog.injected,undefined);
 listener({type:'rez:parse',evidence:{ok:true,viewType:'week'},sessionCatalog:catalog},{},()=>{});
 assert.equal(received.sessionCatalog,catalog);
});


test('isolated listener returns only the validated partial dates with explicit rejected-day metadata',()=>{
 let listener;const good={schema:1,state:'ok',fresh:true,view:{date:'2026-11-03'},slots:[]};
 const context=createContext({chrome:{runtime:{onMessage:{addListener:l=>listener=l,removeListener(){}}}},document:{},location:{href:'https://rez.metu.edu.tr/view/home.jsf'},RezCalendarParser:{extract:()=>({state:'ok'}),extractFreshWeek:(_d,_u,_e,_n,partial)=>partial?{snapshots:[good],rejectedDates:['2026-11-02']}:null}});
 runInContext(readFileSync(new URL('../content.js',import.meta.url),'utf8'),context);let result;
 listener({type:'rez:parse',evidence:{ok:true,viewType:'week'}},{},r=>result=r);
 assert.equal(result.snapshots.length,1);assert.equal(result.snapshots[0].view.date,'2026-11-03');assert.equal(result.rejectedDates[0],'2026-11-02');
});
