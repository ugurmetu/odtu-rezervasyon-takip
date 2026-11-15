import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import{runInNewContext}from'node:vm';
const source=readFileSync(new URL('../catalog.js',import.meta.url),'utf8');
function fixture({options,units=[],selected='',password=false}={}){const option=(value,textContent,extra={})=>({value,textContent,...extra});const selects={'form:facility_input':{options:options||[option('','Seç'),option('17','Baraka Fitness'),option('49','Yeni Havuz')],value:'17'},...(units.length?{'form:unit_input':{options:units,value:selected}}:{})};const context={globalThis:{},location:{origin:'https://rez.metu.edu.tr',pathname:'/view/home.jsf'},document:{querySelector:()=>password?{}:null,getElementById:id=>selects[id]}};runInNewContext(source,context);return {catalog:context.globalThis.RezCatalog,option};}
test('official choices produce a dynamic registry, ignore placeholders, and recognise a newly listed pool',()=>{const f=fixture(),r=f.catalog.readCatalog();assert.deepEqual(Array.from(r.facilities,x=>[x.id,x.label,x.unit]),[['17','Baraka Fitness','Spor Müdürlüğü'],['49','Yeni Havuz','Havuz Müdürlüğü']]);assert.equal(r.complete,true);assert.equal(r.unitId,null);});
test('explicit directorate and option-group names override name inference and disabled entries remain disabled',()=>{const f=fixture({options:[{value:'50',textContent:'Seans A',disabled:true}],units:[{value:'',textContent:'Seç'},{value:'2',textContent:'Havuz Müdürlüğü'}],selected:'2'});const r=f.catalog.readCatalog();assert.equal(r.facilities[0].unit,'Havuz Müdürlüğü');assert.equal(r.facilities[0].unitId,'2');assert.equal(r.facilities[0].enabled,false);assert.equal(r.units.length,1);});
test('login and empty/error-rendered selections cannot erase the known facility list',()=>{assert.equal(fixture({password:true}).catalog.readCatalog(),null);const r=fixture({options:[{value:'0',textContent:'Seçiniz'}]}).catalog.readCatalog();assert.equal(r.complete,false);assert.equal(r.facilities.length,0);});
test('duplicate IDs and oversized choices are rejected rather than poisoning the shared registry',()=>{assert.equal(fixture({options:[{value:'1',textContent:'A'},{value:'1',textContent:'B'}]}).catalog.readCatalog(),null);assert.equal(fixture({options:Array.from({length:201},(_,i)=>({value:String(i+1),textContent:'Yer'}))}).catalog.readCatalog(),null);});

test('directorate discovery uses the normal unit selector, publishes both lists and does not refresh again before its interval',async()=>{
 let selected='1',reloads=0,published=[];const state={};const tab={id:10,url:'https://rez.metu.edu.tr/view/home.jsf?rez-discovery=1',status:'complete'};
 const units=[{id:'1',label:'Spor Müdürlüğü'},{id:'2',label:'Havuz Müdürlüğü'}];
 const chrome={storage:{local:{get:async()=>({...state}),set:async v=>Object.assign(state,v)}},tabs:{query:async()=>[tab],reload:async()=>reloads++},scripting:{executeScript:async({func,args=[]})=>{
  if(func.name==='inspectPage')return [{frameId:0,result:{page:'home'}}];
  if(func.name==='readCatalog')return [{frameId:0,result:{source:'official-facility-select',units,unitId:selected,complete:true,facilities:[{id:selected==='1'?'17':'49',label:selected==='1'?'Fitness':'Havuz',unit:units.find(u=>u.id===selected).label,unitId:selected}]}}];
  if(func.name==='selectUnit'){selected=args[0];return [{frameId:0,result:true}];}throw new Error('Unexpected action');
 }}};
 const context={globalThis:{},setTimeout,clearTimeout,URL,RezRecovery:{inspectPage:function inspectPage(){}},AbortSignal,fetch:async(_url,options)=>{published.push(JSON.parse(options.body));return{ok:true};}};runInNewContext(source,context);const run=()=>context.globalThis.RezCatalog.run(chrome,{catalogDiscovery:true,key:'synthetic',watchFacilities:['17']});
 await run();await run();await run();assert.equal(published.length,2);assert.deepEqual(published.map(x=>x.unitId),['1','2']);assert.equal(state.catalogJob,null);assert.ok(state.catalogLastSweepAt);assert.equal(reloads,1);assert.equal(await run(),null);
});
test('a source access denial is reported before any catalogue request or challenge action',async()=>{
 const state={catalogJob:{startedAt:Date.now(),tabId:10,seen:[]}},posts=[];const chrome={storage:{local:{get:async()=>state,set:async()=>{}}},tabs:{query:async()=>[{id:10,url:'https://rez.metu.edu.tr/view/home.jsf?rez-discovery=1',status:'complete'}]},scripting:{executeScript:async()=>[{frameId:0,result:{page:'blocked'}}]}};
 const context={globalThis:{},setTimeout,clearTimeout,URL,RezRecovery:{inspectPage:function inspectPage(){}},fetch:async()=>posts.push(1)};runInNewContext(source,context);assert.equal((await context.globalThis.RezCatalog.run(chrome,{catalogDiscovery:true})).phase,'site_access_denied');assert.equal(posts.length,0);
});

test('single-tab catalog discovery fetches a new source document without reloading or replacing the existing collector',async()=>{
 let reloads=0,posts=0;const state={},tab={id:42,status:'complete',url:'https://rez.metu.edu.tr/view/home.jsf'};
 const chrome={storage:{local:{get:async()=>({...state}),set:async v=>Object.assign(state,v)}},tabs:{query:async()=>[tab],reload:async id=>{assert.equal(id,42);reloads++;},create:async()=>assert.fail('duplicate view')},scripting:{executeScript:async({func})=>[{frameId:0,result:func.name==='inspectPage'?{page:'home'}:{units:[],unitId:null,complete:true,facilities:[{id:'17',label:'Fitness',unit:'Spor Müdürlüğü'}]}}]}};
 const context={globalThis:{},setTimeout,clearTimeout,URL,AbortSignal,RezRecovery:{ensureManagedTab:async()=>tab,inspectPage:function inspectPage(){}},fetch:async()=>{posts++;return{ok:true};}};
 runInNewContext(source,context);const c={singleTab:true,catalogDiscovery:true,watchFacilities:['17'],reservePreparation:async()=>true};
 await context.globalThis.RezCatalog.run(chrome,c);await context.globalThis.RezCatalog.run(chrome,c);
 assert.equal(reloads,0);assert.equal(posts,1);assert.equal(state.catalogJob,null);assert.equal(await context.globalThis.RezCatalog.run(chrome,c),null);
});

test('fresh catalog HTTP reads parse unexecuted official HTML and stop on source denial or expired login',async()=>{
 let status=200,kind='basic',password=false,parsed=0;const requests=[];
 const doc={querySelector:()=>password?{}:null,getElementById:id=>id==='form:facility_input'?{options:[{value:'49',textContent:'Yeni Havuz'}]}:null};
 const context={globalThis:{},AbortSignal,location:{origin:'https://rez.metu.edu.tr',pathname:'/view/home.jsf'},document:{querySelector:()=>null},
  DOMParser:class{parseFromString(text,type){assert.equal(type,'text/html');parsed++;return doc;}},fetch:async(url,options)=>{requests.push([url,options]);return {status,type:kind,ok:status===200,text:async()=>'<html>synthetic catalog</html>'};}};
 runInNewContext(source,context);const read=()=>context.globalThis.RezCatalog.readCatalog(true);
 assert.equal((await read()).facilities[0].id,'49');assert.equal(requests[0][0],'/view/home.jsf');assert.equal(requests[0][1].credentials,'same-origin');assert.equal(requests[0][1].redirect,'manual');assert.equal(requests[0][1].cache,'no-store');
 status=403;assert.equal((await read()).phase,'site_access_denied');status=429;assert.equal((await read()).phase,'site_rate_limited');assert.equal(parsed,1);
 status=200;password=true;assert.equal((await read()).phase,'login_required');password=false;kind='opaqueredirect';assert.equal((await read()).phase,'login_required');
});
test('failed fresh metadata checks defer catalog discovery instead of blocking the shared calendar reader',async()=>{
 const state={catalogJob:{startedAt:Date.now(),tabId:42,seen:[],fresh:true}},tab={id:42,status:'loading',url:'https://rez.metu.edu.tr/view/home.jsf'};let posts=0;
 const chrome={storage:{local:{get:async()=>({...state}),set:async v=>Object.assign(state,v)}},tabs:{query:async()=>[tab]},scripting:{executeScript:async({func,args})=>[{frameId:0,result:func.name==='inspectPage'?{page:'home'}:(assert.equal(args[0],true),null)}]}};
 const context={globalThis:{},setTimeout,clearTimeout,URL,AbortSignal,RezRecovery:{ensureManagedTab:async()=>tab,inspectPage:function inspectPage(){}},fetch:async()=>{posts++;return{ok:true};}};
 runInNewContext(source,context);const c={singleTab:true,catalogDiscovery:true,watchFacilities:['17'],reservePreparation:async()=>true};
 assert.equal((await context.globalThis.RezCatalog.run(chrome,c)).deferred,true);assert.equal(posts,0);assert.equal(state.catalogJob,null);assert.ok(state.catalogLastSweepAt);
});
