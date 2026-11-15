import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {exportPublicSource} from '../export-public-source.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const epoch=value=>typeof value==='number'?value:Date.parse(value||'');
const age=(at,value)=>(epoch(at)-epoch(value))/1000;
const validAge=(at,value,limit)=>Number.isFinite(age(at,value))&&age(at,value)>=-30&&age(at,value)<=limit;
const states=['login_required','calendar_unavailable','no_tab','paused'];

export function discoverTestFiles(root=project){
 const files=[];
 function walk(dir){
  if(!fs.existsSync(path.join(root,dir)))return;
  for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
   if(entry.name.startsWith('.')||entry.name==='node_modules'||entry.isSymbolicLink())continue;
   const name=`${dir}/${entry.name}`;
   if(entry.isDirectory())walk(name);
   else if(entry.isFile()&&entry.name.endsWith('.test.mjs')&&name!=='test/telegram.test.mjs')files.push(name);
  }
 }
 for(const dir of ['test','extension/test','ops'])walk(dir);
 return [...new Set(files)].sort();
}

export function assessNightly(samples,inventory,tests,previous=null){
 const good=samples.filter(s=>!s.error&&Number.isFinite(epoch(s.at))),issues=[],warnings=[];
 const add=code=>issues.push(code),warn=code=>warnings.push(code),last=good.at(-1),now=last?.at||inventory?.at||new Date().toISOString();
 if(tests.exitCode!==0||tests.count===0)add('regression_tests_failed');
 if(tests.timedOut)add('regression_tests_timeout');
 if(tests.sourceChanged)warn('source_changed_during_tests');
 if(tests.excluded?.length)warn('legacy_test_excluded');
 if(!inventory)add('inventory_unavailable');
 else{
  if(!inventory.releaseMatches||inventory.sourceMismatches?.length)add('deployed_source_mismatch');
  if(inventory.extensionVersion&&last?.version&&inventory.extensionVersion!==last.version)add('reader_version_mismatch');
  if(!Object.keys(inventory.services||{}).length)add('services_unverified');
  for(const[name,s]of Object.entries(inventory.services||{})){
   if(s.ActiveState!=='active'||(s.SubState&&s.SubState!=='running')||('MainPID'in s&&Number(s.MainPID)<=0))add(name+'_inactive');
   if(Number(s.NRestarts)>Number(previous?.restarts?.[name]||0))add(name+'_restarts_increased');
   const previousPid=previous?.pids?.[name];
   if(previousPid&&s.MainPID&&String(previousPid)!==String(s.MainPID))warn(name+'_pid_changed');
  }
  if(inventory.privateDirectoryMode!==undefined&&(inventory.privateDirectoryMode&0o077)!==0)add('private_file_permissions');
  if(Object.values(inventory.privateFiles||{}).some(p=>p.exists===false||p.privateMode===false||p.ownedByApp===false||p.regular===false))add('private_file_permissions');
  if(inventory.listeners?.some(p=>p.port!==22&&!p.loopback)||last?.localApiOnly===false)add('public_application_listener');
  if(inventory.backup?.valid!==true)add('backup_invalid_or_missing');
  if(inventory.backup?.ageSeconds>48*3600)add('backup_stale');
  else if(inventory.backup?.ageSeconds>24*3600)warn('backup_over_24h');
  if(inventory.backup?.privateMode===false||inventory.backup?.ownedByApp===false||inventory.backup?.directoryPrivateMode===false||inventory.backup?.directoryOwnedByApp===false)add('backup_permissions');
  if(inventory.backupSchedule){
   const b=inventory.backupSchedule;
   if(!b.installed||!b.enabled||!b.active||!b.networkIsolated||!b.nextAt)add('backup_schedule_inactive');
   if(b.lastResult!=='success'||Number(b.lastExitCode)!==0)add('backup_job_failed');
  }
  if(Number.parseInt(inventory.disk?.[3])>=85||inventory.diskAvailableMiB<512)add('disk_almost_full');
  if(inventory.clockSynchronized!=='yes')add('clock_not_synchronized');
  if(inventory.stateValid===false)add('state_invalid');
  for(const field of ['logSummary30m','logSummary24h']){
   const logs=inventory[field]||{};
   if(logs.oom||logs['out of memory']||logs.Unhandled)add('service_crash_log');
   if(field==='logSummary24h'&&(logs['401']||logs['403']||logs['429']||logs.conflict))warn('recent_auth_or_rate_limit_logs');
  }
  const delivery=inventory.delivery||{};
  if(delivery.oldestQueuedAgeSeconds>180)add('delivery_queue_stale');
  if(delivery.oldestSendingAgeSeconds>60)add('delivery_sending_stuck');
  if(delivery.uncertain>0)add('uncertain_delivery');
  if(delivery.recentExpired>0)add('expired_delivery');
  if(delivery.slotUncertain>0||delivery.slotUncertainRecent===true)add('uncertain_slot_update');
  if(delivery.slotFailedRecent===true)add('failed_slot_update');
  if(delivery.oldestSlotJobAgeSeconds>180)add('slot_update_queue_stale');
  if(delivery.broadcastPending>0&&delivery.broadcastAgeSeconds>900)add('weekly_notice_stuck');
  const history=inventory.healthHistory24h;
  if(!history?.samples)warn('health_history_unavailable');
  else{
   if(!validAge(now,history.lastAt,900))add('health_history_stale');
   if(history.maxGapSeconds>900)warn('health_history_gaps');
   if(history.malformed>0)warn('health_history_malformed');
   if(history.observedHours<23.75)warn('health_history_under_24h');
   if(history.calendarTrouble>0||history.telegramTrouble>0||history.deliveryTrouble>0||history.uptimeResets>0)warn('history_contains_incidents');
  }
 }
 const trailingErrors=samples.slice().reverse().findIndex(s=>!s.error);
 if(samples.length>1&&(trailingErrors>=2||trailingErrors===-1))add('telemetry_unavailable');
 if(!last){
  if(samples.filter(s=>s.error).length>1)add('telemetry_unavailable');else warn('one_telemetry_access_error');
 }else{
  if(samples.at(-1)?.error)warn('latest_telemetry_access_error');
  if(last.reader?.phase!=='ready'||!Number.isSafeInteger(last.reader?.total)||last.reader.total<=0||last.reader.fresh!==last.reader.total)add('calendar_not_current');
  if(last.clockConnected!==true)add('reader_clock_disconnected');
  if(!validAge(now,last.telegram?.lastPollAt,90))add('telegram_poll_stale');
  if(last.failed>0)add('failed_delivery');
  if(last.uncertain>0)add('uncertain_delivery');
  if(good.slice(-3).length===3&&good.slice(-3).every(h=>h.queued>0))add('persistent_delivery_queue');
  if(last.operatorAlerts?.ready!==true)add('operator_channel_unavailable');
  const g=last.memoryGuard;
  if(g?.runtimeSupported!==true)add('memory_guard_not_supported');
  if(!validAge(now,g?.lastSample?.at,180))add('memory_guard_sample_stale');
  if(['timeout','failed','reset_limit_reached'].includes(g?.status))add('memory_guard_'+g.status);
  if(g?.pending&&g.pendingAgeSeconds>300)add('memory_guard_request_stuck');
  if(g?.status==='recovered'&&g.lastRecoveredAt&&g.lastRequestAt&&epoch(g.lastRecoveredAt)<epoch(g.lastRequestAt))add('memory_guard_recovery_unproven');
  if(g?.lastRecoveredAt&&!Object.values(last.latestByFacility||{}).some(at=>epoch(at)>epoch(g.lastRecoveredAt)))add('no_read_after_memory_recovery');
  const memory=good.slice(-3).map(h=>h.memoryGuard?.lastSample).filter(Boolean);
  if(memory.length===3&&memory.every(m=>m.currentMiB>=1200&&m.residentMiB>=900))add('browser_memory_sustained_high');
  const trend=g?.history;
  if(trend?.malformed>0)warn('memory_history_malformed');
  if(trend?.observedHours>=1&&trend.endMedianMiB-trend.startMedianMiB>=300&&trend.endMedianMiB>=900)warn('browser_memory_growing');
  if(good.slice(-3).length===3&&good.slice(-3).every(h=>Number.isFinite(h.memoryMiB?.available)&&h.memoryMiB.available<256))add('host_memory_low');
  if(good.slice(-3).length===3&&good.slice(-3).every(h=>h.load?.[0]>2*h.cpuCount))add('host_load_sustained_high');
  if(states.includes(last.lastObservation?.state))add('reader_login_or_calendar_blocked');
  const plan=last.plan;
  if(plan){
   if(plan.facilities!==plan.catalogFacilities||plan.missingCatalogFacilities>0)add('facility_catalog_not_covered');
   if(!plan.dateRangeValid||plan.pastDates>0)add('reader_dates_invalid');
   if(plan.total!==last.reader?.total)add('reader_plan_count_mismatch');
   if(plan.unknownSessionDays>0)warn('session_times_not_all_learned');
  }
  if(good.some(h=>h.reader?.phase!=='ready'||h.reader?.fresh!==h.reader?.total))warn('transient_calendar_trouble');
  for(const name of Object.keys(last.services||{}))if(new Set(good.map(h=>h.services?.[name]?.MainPID).filter(Boolean)).size>1)add(name+'_changed_during_audit');
 }
 const stamps=new Map();
 for(const h of good)for(const[id,at]of Object.entries(h.latestByFacility||{})){
  if(!Number.isFinite(epoch(at))||epoch(at)>epoch(h.at)+30000)continue;
  if(!stamps.has(id))stamps.set(id,new Set());stamps.get(id).add(at);
 }
 const cadence=Object.fromEntries([...stamps].map(([id,set])=>{
  const times=[...set].map(epoch).sort((a,b)=>a-b),diff=times.slice(1).map((at,i)=>(at-times[i])/1000);
  return[id,{updates:times.length,min:diff.length?Math.min(...diff):null,max:diff.length?Math.max(...diff):null,
   latestAgeSeconds:last?age(last.at,times.at(-1)):null}];
 }));
 if(Object.values(cadence).some(c=>c.max>90||c.latestAgeSeconds>90))add('scan_gap_over_90s');
 const span=good.length>1?(epoch(last.at)-epoch(good[0].at))/1000:0;
 const stale=Object.values(cadence).filter(c=>c.updates<2);
 if(span>=180&&stale.length)add('facilities_not_advancing');
 if(span>=90&&last?.plan?.facilities>Object.keys(last.latestByFacility||{}).length)add('facilities_missing_reads');
 if(span>=90&&Number.isFinite(last?.facilitiesReadSinceStart)&&last.facilitiesReadSinceStart<last?.plan?.facilities)add('facilities_missing_reads');
 if(span<180)warn('short_cadence_window');
 if(good.length&&new Set(good.map(h=>h.version).filter(Boolean)).size>1)warn('reader_version_changed_during_audit');
 const stable=[...new Set(issues)].sort(),fingerprint=JSON.stringify(stable),prior=previous?.fingerprint;
 const warningList=[...new Set(warnings)].sort();
 const historical=inventory?.healthHistory24h;
 const reviewRequired=warningList.filter(w=>['health_history_gaps','health_history_stale','history_contains_incidents','browser_memory_growing','session_times_not_all_learned'].includes(w));
 return {schema:2,at:new Date().toISOString(),issues:stable,warnings:warningList,cadence,samples:samples.length,successfulSamples:good.length,observationSeconds:span,
  latest:last?{at:last.at,version:last.version,reader:last.reader,queued:last.queued,failed:last.failed,uncertain:last.uncertain||0,telegramPollAt:last.telegram?.lastPollAt,memoryMiB:last.memoryMiB}:null,
  history24h:historical||null,memoryHistory:last?.memoryGuard?.history||null,backup:inventory?.backup||null,delivery:inventory?.delivery||null,
  restarts:Object.fromEntries(Object.entries(inventory?.services||{}).map(([n,s])=>[n,Number(s.NRestarts)])),
  pids:Object.fromEntries(Object.entries(inventory?.services||{}).map(([n,s])=>[n,s.MainPID])),fingerprint,changed:prior!==undefined&&prior!==fingerprint,
  notify:stable.length>0?(prior!==fingerprint):(previous?.issues?.length>0),reviewRequired,
  limits:['Sampled health is not continuous availability or complete per-session proof','API acceptance is not phone delivery',
   'Live Sunday publication and fully automatic CAPTCHA require direct evidence','legacy test/telegram.test.mjs remains excluded until its mock loop is repaired']};
}

export function bounded(command,args,output,{cwd=project,timeoutMs=180000}={}){
 return new Promise(resolve=>{
  const fd=fs.openSync(output,'w',0o600);let done=false,expired=false;
  const child=spawn(command,args,{cwd,detached:process.platform!=='win32',stdio:['ignore',fd,fd]});
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);fs.closeSync(fd);resolve(value);};
  const timer=setTimeout(()=>{expired=true;try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}},timeoutMs);
  child.once('error',()=>finish({exitCode:1,error:'command_unavailable'}));
  child.once('close',(code,signal)=>finish({exitCode:code??1,signal,timedOut:expired}));
 });
}

async function isolatedTests(folder){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rez-nightly-source-')),snapshot=path.join(temporary,'source');
 try{
  exportPublicSource(project,snapshot);
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'EXPORT-MANIFEST.json'),'utf8'));
  fs.rmSync(path.join(snapshot,'EXPORT-MANIFEST.json'));
  fs.symlinkSync(path.join(project,'node_modules'),path.join(snapshot,'node_modules'),'dir');
  const files=discoverTestFiles(snapshot);
  const result=await bounded(process.execPath,['--max-old-space-size=768','--test','--test-timeout=45000','--test-concurrency=4',...files],path.join(folder,'tests.log'),{cwd:snapshot});
  const log=fs.readFileSync(path.join(folder,'tests.log'),'utf8'),number=k=>Number(new RegExp(`(?:ℹ|#) ${k} (\\d+)`).exec(log)?.[1]||0);
  const sourceChanged=manifest.files.some(f=>{try{return createHash('sha256').update(fs.readFileSync(path.join(project,f.path))).digest('hex')!==f.sha256;}catch{return true;}});
  return {...result,count:number('tests'),passed:number('pass'),failed:number('fail'),skipped:number('skipped'),files:files.length,sourceChanged,isolated:true,excluded:['test/telegram.test.mjs']};
 }catch{
  fs.writeFileSync(path.join(folder,'tests.log'),'Isolated source export/test setup failed; inspect the allowlist and current source.\n',{mode:0o600});
  return {exitCode:1,count:0,error:'isolated_test_setup_failed'};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}

export async function nightlyAudit({samples=16,intervalMs=20000}={}){
 if(!Number.isInteger(samples)||samples<1||samples>31||!Number.isFinite(intervalMs)||intervalMs<0||intervalMs>60000)throw Error('Invalid audit window');
 const base=path.join(project,'.local/nightly-audits'),folder=path.join(base,new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:true,mode:0o700});
 const tests=await isolatedTests(folder);
 await bounded(process.execPath,['ops/vps/audit-inventory.mjs',folder],path.join(folder,'inventory.log'),{timeoutMs:40000});
 let inventory=null;try{inventory=JSON.parse(fs.readFileSync(path.join(folder,'inventory.json'),'utf8'));}catch{}
 const health=[];let failures=0;
 for(let i=0;i<samples;i++){
  const file=path.join(folder,`sample-${i}.json`),r=await bounded(process.execPath,['ops/vps/check-remote.mjs'],file,{timeoutMs:30000});
  try{if(r.exitCode!==0)throw Error();health.push(JSON.parse(fs.readFileSync(file,'utf8')));failures=0;}
  catch{health.push({at:new Date().toISOString(),error:'telemetry_unavailable'});failures++;}
  if(failures>=3)break;if(i+1<samples)await sleep(intervalMs);
 }
 let prior=null;try{prior=JSON.parse(fs.readFileSync(path.join(base,'last-summary.json'),'utf8'));}catch{}
 const summary={...assessNightly(health,inventory,tests,prior),tests,reportDirectory:path.relative(project,folder)};
 const bytes=JSON.stringify(summary,null,2)+'\n';fs.writeFileSync(path.join(folder,'summary.json'),bytes,{mode:0o600});
 const temporary=path.join(base,'last-summary.json.tmp');fs.writeFileSync(temporary,bytes,{mode:0o600});fs.renameSync(temporary,path.join(base,'last-summary.json'));
 return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const quick=process.argv.includes('--quick'),result=await nightlyAudit(quick?{samples:2,intervalMs:1000}:{});
 console.log(JSON.stringify({at:result.at,issues:result.issues,warnings:result.warnings,reviewRequired:result.reviewRequired,changed:result.changed,notify:result.notify,tests:result.tests,reportDirectory:result.reportDirectory}));
 if(result.issues.length)process.exitCode=1;
}
