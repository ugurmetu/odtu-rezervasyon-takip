import test from 'node:test';import assert from 'node:assert/strict';import {assessNightly} from '../ops/vps/nightly-audit.mjs';
const at='2026-10-29T12:00:00Z';
function healthy(){return {at,reader:{phase:'ready',fresh:4,total:4},clockConnected:true,telegram:{lastPollAt:at},queued:0,failed:0,operatorAlerts:{ready:true},memoryGuard:{runtimeSupported:true,status:'observing',lastSample:{at}},latestByFacility:{'17':at}};}
const inventory=()=>({releaseMatches:true,sourceMismatches:[],services:{bot:{ActiveState:'active',NRestarts:'0'}},privateFiles:{x:{privateMode:true,ownedByApp:true}},listeners:[{port:22,loopback:false},{port:8765,loopback:true}],backup:{valid:true},disk:['1','1','1','10%'],clockSynchronized:'yes',logSummary30m:{}});
test('healthy repeat stays quiet, regression and recovery are reported once',()=>{const h=[healthy()],ok=assessNightly(h,inventory(),{exitCode:0});assert.deepEqual(ok.issues,[]);assert.equal(ok.notify,false);const bad=assessNightly(h,inventory(),{exitCode:1},ok);assert.equal(bad.notify,true);assert.equal(assessNightly(h,inventory(),{exitCode:1},bad).notify,false);assert.equal(assessNightly(h,inventory(),{exitCode:0},bad).notify,true);});
test('a single access error is not labelled an ODTU outage; stale telemetry and missing private operator routing remain distinct',()=>{const one=assessNightly([{error:'telemetry_unavailable'}],inventory(),{exitCode:0});assert.equal(one.issues.includes('calendar_not_current'),false);assert.equal(one.issues.includes('telemetry_unavailable'),false);const h=healthy();h.operatorAlerts.ready=false;h.memoryGuard.lastSample.at='2026-10-29T11:50:00Z';const r=assessNightly([h],inventory(),{exitCode:0});assert.ok(r.issues.includes('operator_channel_unavailable'));assert.ok(r.issues.includes('memory_guard_sample_stale'));});
test('observed gaps over 90s are separate from nominal fresh coverage',()=>{const a=healthy(),b=healthy();b.at='2026-10-29T12:02:00Z';b.telegram.lastPollAt=b.at;b.memoryGuard.lastSample.at=b.at;b.latestByFacility={'17':'2026-10-29T12:01:40Z'};const r=assessNightly([a,b],inventory(),{exitCode:0});assert.ok(r.issues.includes('scan_gap_over_90s'));assert.equal(r.issues.includes('calendar_not_current'),false);});

test('an empty reader cannot pass as 0/0 fresh',()=>{const h=healthy();h.reader={phase:'ready',fresh:0,total:0};assert.ok(assessNightly([h],inventory(),{exitCode:0}).issues.includes('calendar_not_current'));});
test('invalid, future and stale Telegram poll timestamps fail instead of passing a NaN comparison',()=>{
 for(const lastPollAt of ['not-a-date','2026-10-29T12:05:00Z','2026-10-29T11:50:00Z']){const h=healthy();h.telegram.lastPollAt=lastPollAt;assert.ok(assessNightly([h],inventory(),{exitCode:0}).issues.includes('telegram_poll_stale'));}
});
test('uncertain, stuck, expired and missing Full/reopened jobs are assessed separately',()=>{
 const i=inventory();i.delivery={oldestQueuedAgeSeconds:181,oldestSendingAgeSeconds:61,uncertain:1,recentExpired:1,slotUncertain:1,slotFailedRecent:true,oldestSlotJobAgeSeconds:181,broadcastPending:2,broadcastAgeSeconds:901};
 const r=assessNightly([healthy()],i,{exitCode:0});
 for(const code of ['delivery_queue_stale','delivery_sending_stuck','uncertain_delivery','expired_delivery','uncertain_slot_update','failed_slot_update','slot_update_queue_stale','weekly_notice_stuck'])assert.ok(r.issues.includes(code),code);
});
test('one short delivery queue is allowed while a persistent queue is reported',()=>{
 const h=healthy();h.queued=2;assert.equal(assessNightly([h],inventory(),{exitCode:0}).issues.includes('persistent_delivery_queue'),false);
 assert.ok(assessNightly([h,h,h],inventory(),{exitCode:0}).issues.includes('persistent_delivery_queue'));
});
test('a single bad read that recovers is recorded without calling the final reader broken',()=>{
 const bad=healthy(),good=healthy();bad.reader.phase='preparing';const r=assessNightly([bad,good],inventory(),{exitCode:0});assert.ok(r.warnings.includes('transient_calendar_trouble'));assert.equal(r.issues.includes('calendar_not_current'),false);
});
test('later telemetry failures cannot be hidden by an earlier successful sample',()=>{
 const r=assessNightly([healthy(),{error:'telemetry_unavailable'},{error:'telemetry_unavailable'}],inventory(),{exitCode:0});assert.ok(r.issues.includes('telemetry_unavailable'));assert.equal(r.issues.includes('calendar_not_current'),false);
});
test('a facility which never advances during the observation window is detected despite fresh counters',()=>{
 const a=healthy(),b=healthy();b.at='2026-10-29T12:04:00Z';b.telegram.lastPollAt=b.at;b.memoryGuard.lastSample.at=b.at;
 const r=assessNightly([a,b],inventory(),{exitCode:0});assert.ok(r.issues.includes('facilities_not_advancing'));assert.ok(r.issues.includes('scan_gap_over_90s'));
});
test('a future facility timestamp is never accepted as a new successful read',()=>{
 const h=healthy();h.latestByFacility={'17':'2026-10-29T12:10:00Z'};assert.deepEqual(assessNightly([h],inventory(),{exitCode:0}).cadence,{});
});
test('runtime version, all facilities and published date range are checked independently of 96/96 counters',()=>{
 const h=healthy();h.version='0.10.7';h.plan={facilities:31,catalogFacilities:32,missingCatalogFacilities:1,total:93,dateRangeValid:false,pastDates:1,unknownSessionDays:3};const i=inventory();i.extensionVersion='0.10.4';
 const r=assessNightly([h],i,{exitCode:0});for(const code of ['reader_version_mismatch','facility_catalog_not_covered','reader_dates_invalid','reader_plan_count_mismatch'])assert.ok(r.issues.includes(code),code);
 assert.ok(r.warnings.includes('session_times_not_all_learned'));
});
test('known missing session definitions remain a review item, never invented vacancies',()=>{
 const h=healthy();h.plan={facilities:1,catalogFacilities:1,missingCatalogFacilities:0,total:4,dateRangeValid:true,pastDates:0,unknownSessionDays:1};const r=assessNightly([h],inventory(),{exitCode:0});assert.deepEqual(r.issues,[]);assert.ok(r.reviewRequired.includes('session_times_not_all_learned'));
});
test('stale guard samples, reset limits and stuck requests are detected',()=>{
 for(const status of ['timeout','failed','reset_limit_reached']){const h=healthy();h.memoryGuard.status=status;h.memoryGuard.pending=true;h.memoryGuard.pendingAgeSeconds=301;const r=assessNightly([h],inventory(),{exitCode:0});assert.ok(r.issues.includes('memory_guard_'+status));assert.ok(r.issues.includes('memory_guard_request_stuck'));}
});
test('a recovery flag without subsequent real reads is not recovery proof',()=>{
 const h=healthy();h.memoryGuard.status='recovered';h.memoryGuard.lastRequestAt=Date.parse('2026-10-29T11:50:00Z');h.memoryGuard.lastRecoveredAt=Date.parse('2026-10-29T12:00:00Z');
 assert.ok(assessNightly([h],inventory(),{exitCode:0}).issues.includes('no_read_after_memory_recovery'));
 h.latestByFacility['17']='2026-10-29T12:00:01Z';assert.equal(assessNightly([h],inventory(),{exitCode:0}).issues.includes('no_read_after_memory_recovery'),false);
});
test('RAM trend and sustained pressure differ from one brief peak',()=>{
 const h=healthy();h.memoryGuard.lastSample={at,currentMiB:1250,residentMiB:1000};h.memoryMiB={available:200};h.load=[5,3,2];h.cpuCount=2;
 h.memoryGuard.history={observedHours:3,startMedianMiB:500,endMedianMiB:1000};
 const once=assessNightly([h],inventory(),{exitCode:0});assert.ok(once.warnings.includes('browser_memory_growing'));assert.equal(once.issues.includes('browser_memory_sustained_high'),false);
 const r=assessNightly([h,h,h],inventory(),{exitCode:0});for(const code of ['browser_memory_sustained_high','host_memory_low','host_load_sustained_high'])assert.ok(r.issues.includes(code));
});
test('24h history gaps, absent coverage and old records do not prove 24h stability',()=>{
 const i=inventory();i.healthHistory24h={samples:24,lastAt:'2026-10-29T11:00:00Z',observedHours:2,maxGapSeconds:1200,calendarTrouble:1,uptimeResets:1,malformed:1};
 const r=assessNightly([healthy()],i,{exitCode:0});assert.ok(r.issues.includes('health_history_stale'));
 for(const code of ['health_history_gaps','health_history_under_24h','history_contains_incidents','health_history_malformed'])assert.ok(r.warnings.includes(code));
 assert.ok(r.limits.some(s=>s.includes('continuous')));
});
test('backup age, permission, missing secrets and exposed local APIs are checked',()=>{
 const i=inventory();i.backup={valid:true,ageSeconds:49*3600,privateMode:false};i.privateDirectoryMode=0o755;i.privateFiles.x.exists=false;i.listeners.push({port:9222,loopback:false});
 const r=assessNightly([healthy()],i,{exitCode:0});for(const code of ['backup_stale','backup_permissions','private_file_permissions','public_application_listener'])assert.ok(r.issues.includes(code));
});
test('a fresh file cannot hide a root-owned backup directory or a disabled, failed or network-capable scheduler',()=>{
 const i=inventory();i.backup={valid:true,ageSeconds:5,directoryPrivateMode:true,directoryOwnedByApp:true};
 i.backupSchedule={installed:true,enabled:true,active:true,networkIsolated:true,nextAt:'2026-11-05T06:30:00Z',lastResult:'success',lastExitCode:'0'};
 assert.deepEqual(assessNightly([healthy()],i,{exitCode:0}).issues,[]);
 for(const field of ['directoryPrivateMode','directoryOwnedByApp']){const bad=structuredClone(i);bad.backup[field]=false;assert.ok(assessNightly([healthy()],bad,{exitCode:0}).issues.includes('backup_permissions'));}
 for(const field of ['installed','enabled','active','networkIsolated','nextAt']){const bad=structuredClone(i);bad.backupSchedule[field]=false;assert.ok(assessNightly([healthy()],bad,{exitCode:0}).issues.includes('backup_schedule_inactive'));}
 const failed=structuredClone(i);failed.backupSchedule.lastResult='exit-code';failed.backupSchedule.lastExitCode='1';assert.ok(assessNightly([healthy()],failed,{exitCode:0}).issues.includes('backup_job_failed'));
});
test('corrupt state, invalid backup, disk exhaustion and fatal 24h logs are separate failures',()=>{
 const i=inventory();i.stateValid=false;i.backup.valid=false;i.diskAvailableMiB=200;i.logSummary24h={oom:1,'429':4};
 const r=assessNightly([healthy()],i,{exitCode:0});for(const code of ['state_invalid','backup_invalid_or_missing','disk_almost_full','service_crash_log'])assert.ok(r.issues.includes(code));assert.ok(r.warnings.includes('recent_auth_or_rate_limit_logs'));
});
test('process changes during the audit are distinguished from a changed PID between daily runs',()=>{
 const a=healthy(),b=healthy();a.services={bot:{MainPID:'1'}};b.services={bot:{MainPID:'2'}};const i=inventory();i.services.bot.MainPID='2';
 const r=assessNightly([a,b],i,{exitCode:0},{pids:{bot:'1'},restarts:{bot:0}});assert.ok(r.issues.includes('bot_changed_during_audit'));assert.ok(r.warnings.includes('bot_pid_changed'));
});
test('empty and timed out test runs fail; concurrent source edits remain explicit',()=>{
 const r=assessNightly([healthy()],inventory(),{exitCode:0,count:0,timedOut:true,sourceChanged:true,excluded:['legacy']});assert.ok(r.issues.includes('regression_tests_failed'));assert.ok(r.issues.includes('regression_tests_timeout'));assert.ok(r.warnings.includes('source_changed_during_tests'));assert.ok(r.warnings.includes('legacy_test_excluded'));
});
test('nightly discovery includes operator tests under ops and avoids symlinked or legacy suites',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{discoverTestFiles}=await import('../ops/vps/nightly-audit.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-discovery-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['test/current.test.mjs','test/telegram.test.mjs','extension/test/a.test.mjs','ops/vps/notify-operator.test.mjs']){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),'');}
 fs.symlinkSync(path.join(dir,'test'),path.join(dir,'ops','linked'),'dir');
 assert.deepEqual(discoverTestFiles(dir),['extension/test/a.test.mjs','ops/vps/notify-operator.test.mjs','test/current.test.mjs']);
});
test('the bounded runner stops a hung local test and reports spawn failures',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{bounded}=await import('../ops/vps/nightly-audit.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nightly-timeout-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const hung=await bounded(process.execPath,['-e','setInterval(()=>{},1000)'],path.join(dir,'hung.log'),{timeoutMs:100});assert.equal(hung.timedOut,true);assert.notEqual(hung.exitCode,0);
 const missing=await bounded(path.join(dir,'missing'),[],path.join(dir,'missing.log'),{timeoutMs:100});assert.equal(missing.error,'command_unavailable');
});
