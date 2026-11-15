import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const connection = JSON.parse(readFileSync(new URL('../../.local/vps-connection.json', import.meta.url), 'utf8'));
const code = String.raw`
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import {pickerDates} from '/opt/odtu-rez/current/src/telegram-picker.mjs';
import {isReaderFacility} from '/opt/odtu-rez/current/src/reader-facilities.mjs';
const key=readFileSync('/var/lib/odtu-rez/private/ingest.key','utf8').trim();
const h=await(await fetch('http://127.0.0.1:8765/health',{headers:{'X-Local-Key':key},signal:AbortSignal.timeout(5000)})).json();
const services={};
for(const name of ['odtu-rez','odtu-rez-display','odtu-rez-browser']){
 const out=execFileSync('systemctl',['show',name+'.service','-p','ActiveState','-p','SubState','-p','MemoryCurrent','-p','MemoryPeak','-p','MainPID','-p','NRestarts','-p','CPUUsageNSec'],{encoding:'utf8'});
 services[name]=Object.fromEntries(out.trim().split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
}
const state=JSON.parse(readFileSync('/var/lib/odtu-rez/private/state.json','utf8'));
const latest={};
for(const page of Object.values(state.engine?.pages||{})){
 if(!(state.readerPlan?.dates||[]).includes(page.date))continue;
 const id=String(page.facility?.id||'');if(!latest[id]||latest[id]<page.lastSuccessAt)latest[id]=page.lastSuccessAt;
}
const listeners=execFileSync('ss',['-lnt'],{encoding:'utf8'});
const free=execFileSync('free',['-m'],{encoding:'utf8'}).split('\n').find(l=>l.startsWith('Mem:'))?.trim().split(/\s+/);
let memoryGuard=null;
try{
 const guard=JSON.parse(readFileSync('/var/lib/odtu-rez/private/memory-guard.json','utf8'));
 const history=[];let malformed=0;
 for(const suffix of ['.1',''])try{
  for(const line of readFileSync('/var/lib/odtu-rez/private/memory-history.ndjson'+suffix,'utf8').trim().split('\n')){
   try{const row=JSON.parse(line),at=Date.parse(row.at);if(Number.isFinite(at)&&Date.now()-at>=0&&Date.now()-at<=86400000)history.push(row);}catch{malformed++;}
  }
 }catch{}
 history.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const median=rows=>{const v=rows.map(s=>s.currentMiB).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null;};
 const firstAt=Date.parse(history[0]?.at),lastAt=Date.parse(history.at(-1)?.at);
 const start=history.filter(s=>Date.parse(s.at)<=firstAt+600000),end=history.filter(s=>Date.parse(s.at)>=lastAt-600000);
 memoryGuard={runtimeSupported:h.readerCapabilities?.memoryGuard===true,status:guard.status,lastSample:guard.lastSample,lastRequestAt:guard.lastRequestAt||null,lastRecoveredAt:guard.lastRecoveredAt||null,
  resetsInSixHours:guard.requests?.length||0,pending:!!guard.pending,pendingAgeSeconds:guard.pending?Math.max(0,(Date.now()-guard.pending.at)/1000):0,
  history:{samples:history.length,from:history[0]?.at,to:history.at(-1)?.at,observedHours:history.length?(lastAt-firstAt)/3600000:0,minMiB:history.length?Math.min(...history.map(s=>s.currentMiB)):null,maxMiB:history.length?Math.max(...history.map(s=>s.currentMiB)):null,startMedianMiB:median(start),endMedianMiB:median(end),malformed}};
}catch{}
const catalog=(h.facilityCatalog||[]).filter(isReaderFacility),plan=state.readerPlan||{},dates=plan.dates||[],expectedDates=pickerDates();
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date());
let unknownSessionDays=0;
for(const id of plan.facilityIds||[])for(const date of dates){
 const recorded=state.sessionCatalog?.[id+'|'+date]?.sessions||[],page=state.engine?.pages?.[id+'|'+date];
 if(!recorded.length&&!Object.keys(page?.slots||{}).length)unknownSessionDays++;
}
console.log(JSON.stringify({at:new Date().toISOString(),version:h.readerCapabilities?.version,reader:h.reader,clockConnected:h.readerClock?.connected,
 lastObservation:{state:h.lastObservation?.lastState,at:h.lastObservation?.lastSeenAt},
 readerAutoRefresh:h.readerAutoRefresh||null,
 telegram:{configured:h.telegram?.configured,startedAt:h.telegram?.startedAt,lastPollAt:h.telegram?.lastPollAt},
 queued:h.queued,sending:h.sending,uncertain:h.uncertain,expired:h.expired,failed:h.failed,readerStats:h.readerStats,services,memoryGuard,
 load:os.loadavg(),cpuCount:os.cpus().length,
 plan:{facilities:(plan.facilityIds||[]).length,catalogFacilities:catalog.length,missingCatalogFacilities:catalog.filter(f=>!(plan.facilityIds||[]).includes(f.id)).length,total:(plan.facilityIds||[]).length*dates.length,
 dateRangeValid:JSON.stringify(dates)===JSON.stringify(expectedDates),pastDates:dates.filter(d=>d<today).length,unknownSessionDays},
 operatorAlerts:h.operatorAlerts?{configured:h.operatorAlerts.configured===true,ready:h.operatorAlerts.ready===true,reason:h.operatorAlerts.reason,checkedAt:h.operatorAlerts.checkedAt,lastSentAt:h.operatorAlerts.lastSentAt,lastErrorAt:h.operatorAlerts.lastErrorAt}:null,
 latestByFacility:latest,
 facilitiesReadSinceStart:h.telegram?.startedAt?Object.values(latest).filter(at=>Date.parse(at)>=Date.parse(h.telegram.startedAt)).length:null,
 memoryMiB:free?{total:+free[1],used:+free[2],available:+free[6]}:null,
 localApiOnly:listeners.includes('127.0.0.1:8765')&&!/0\.0\.0\.0:8765|\[::\]:8765/.test(listeners)}));
`;
try {
  const output=execFileSync('ssh',['-i',connection.key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',connection.host,
    'sudo -u rez /opt/odtu-rez/runtime/node/bin/node --input-type=module'],{input:code,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:20000});
  JSON.parse(output); process.stdout.write(output);
}catch{
  console.error(JSON.stringify({ok:false,error:'remote_health_unavailable'})); process.exitCode=1;
}
