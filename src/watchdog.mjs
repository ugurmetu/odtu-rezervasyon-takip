#!/usr/bin/env node
import {isPublicationWait} from './publication-wait.mjs';
// Server-side watchdog. A root systemd timer runs `node src/watchdog.mjs run`
// every minute, outside the bot and Chrome, so it also works while the owner's
// Mac and Codex are off. It restarts Chrome (then the bot as well) only when
// the reservation site answers but nothing has been read for a while. It never
// touches human verification, sign-in or a site refusal, never starts a system
// that was stopped by hand, and shares one lock, hold switch and ledger with
// the memory guard, deploys and Codex/Claude repairs. Recovery counts only when
// new facility reads arrive after the restart (31 Oct 2026 Codex/Claude rules).
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {activeLock,acquireLock,releaseLock,activeHold,setHold,clearHold,appendLedger,readLedger} from './intervention.mjs';

export const LIMITS={stuckMs:180_000,signingInMs:600_000,settleMs:300_000,perHour:3,perDay:6,recoveredFacilities:5,verifyGiveUpMs:600_000};
// The owner (or a person at the server screen) has to act; restarting would
// only repeat the sign-in, the verification or the refused request.
export const OWNER_PHASES=new Set(['waiting_verification','login_required','login_failed','credentials_missing','credentials_locked',
 'credentials_unavailable','site_access_denied','site_rate_limited','paused']);
const AUTOMATIC=new Set(['watchdog','memory-guard']),RESTARTS=new Set(['restart_browser','restart_all','rotate_tab']);
const SERVICES={bot:'odtu-rez.service',browser:'odtu-rez-browser.service',display:'odtu-rez-display.service'};

// A normal page reload briefly changes diagnostics. Keep only a short,
// plan-scoped grace after positive publication-wait evidence; never extend
// it merely because coverage is zero or a previous grace was used.
export function publicationWindow({rawWait,state,reader,services={},healthOk,now,previous=null}){
 const plan=state.readerPlan||{},key=JSON.stringify([plan.facilityIds,plan.dates]);
 const failed=Object.values(services).some(s=>s?.active!=='active');
 if(!healthOk||failed||!['ready','preparing','reconnecting','waiting_publication'].includes(reader?.phase))return {waiting:false,mark:previous};
 if(rawWait)return {waiting:true,mark:{at:now,key}};
 const seen=Date.parse(state.engine?.health?.lastSeenAt||'');
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(now));
 const scopedRead=Object.values(state.engine?.pages||{}).some(p=>plan.dates?.includes(p?.date)&&Number.isFinite(Date.parse(p.lastSuccessAt||'')));
 const transition=['calendar_date_mismatch','unverified_response','ambiguous_request','no_schedule_request','calendar_view_unavailable'].includes(state.lastDiagnostic);
 const grace=previous?.key===key&&Number.isFinite(previous.at)&&now>=previous.at&&now-previous.at<=120000
  &&['ready','preparing','reconnecting','waiting_publication'].includes(reader?.phase)
  &&state.engine?.health?.lastState==='calendar_unavailable'&&transition
  &&Number.isFinite(seen)&&now>=seen&&now-seen<=180000
  &&plan.dates?.[0]>today&&!scopedRead;
 return {waiting:!!grace,mark:previous};
}

const saveWatchdog=(file,value)=>{const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);};
// The durable limit marker is independent of the transient restart episode.
// Migrate the previous accepted/uncertain notice too. Reserve BEFORE sending,
// so a process exit after API acceptance cannot send the same notice again.
export async function deliverWatchdogNotice({file,state,decision,now,readsSince=()=>0,send}){
 const legacy=state.lastNotice?.action==='limit'?state.lastNotice:null;
 const prior=state.limitNotice||legacy;
 const guard=Number.isFinite(prior?.at)?{at:prior.at}:null;
 const next={...state,limitNotice:guard};
 const limit=decision.action==='limit'&&decision.notify;
 if(!limit&&decision.action!=='recovered')return next;
 if(limit&&guard&&readsSince(guard.at)<LIMITS.recoveredFacilities)return next;
 const text=noticeText(decision);if(!text)return next;
 next.lastNotice={at:now,action:decision.action,result:'reserved'};
 if(limit)next.limitNotice={at:now};
 saveWatchdog(file,next);
 try{next.lastNotice.result=await send(text);}catch{next.lastNotice.result='uncertain';}
 return next;
}

// Pure decision. site is null until the runner probed it on request.
export function decide({now,services={},healthOk=true,reader=null,maintenance=false,lastReadAt=0,readsSince=()=>0,
 site=null,hold=null,lock=null,ledger=[],episode=null,publicationWait=false}){
 const ep=episode||null;
 if(hold)return {action:'hold',reason:hold.reason||'hold',episode:ep};
 if(maintenance)return {action:'hold',reason:'maintenance',episode:ep};
 const stoppedByHand=Object.entries(services).filter(([,s])=>s?.active==='inactive'&&s.result==='success').map(([name])=>name);
 if(stoppedByHand.length)return {action:'hold',reason:'stopped_by_hand:'+stoppedByHand.join(','),episode:ep};
 const failed=Object.entries(services).filter(([,s])=>s?.active==='failed').map(([name])=>name);
 // Fresh expected date rejections are not a crashed/hung collector. Close
 // the false restart episode without a recovery notice; preserve its ledger.
 if(!failed.length&&healthOk&&publicationWait)return {action:'publication_wait',reason:'future_calendar_unconfirmed',episode:null};
 const phase=reader?.phase||null,quietMs=now-(lastReadAt||0);
 const limit=phase==='signing_in'?LIMITS.signingInMs:LIMITS.stuckMs;
 // A health check that briefly fails (the bot restarting) is not a reason on
 // its own: reads must have stopped as well.
 if(!failed.length&&quietMs<=limit){
  if(!ep?.actions?.length)return {action:'ok',episode:null};
  const last=ep.actions.at(-1).at;
  if(readsSince(last)>=LIMITS.recoveredFacilities)return {action:'recovered',episode:null,recovered:{since:ep.since,actions:ep.actions,at:now}};
  if(now-last>LIMITS.verifyGiveUpMs)return {action:'ok',reason:'reads_without_full_confirmation',episode:null};
  return {action:'verify',episode:ep};
 }
 const episodeNow={since:ep?.since||Math.min(now,lastReadAt?lastReadAt:now),actions:ep?.actions||[],limitNotified:ep?.limitNotified||false,siteDownSince:ep?.siteDownSince||null};
 if(!failed.length&&OWNER_PHASES.has(phase))return {action:'owner',reason:phase,episode:episodeNow};
 if(lock)return {action:'locked',reason:lock.owner,episode:episodeNow};
 // A crashed service is restarted whatever the site does; otherwise only
 // when the site answers, so an outage at METU causes no restarts.
 if(!failed.length){
  if(site===null)return {action:'probe',episode:episodeNow};
  if(site==='blocked')return {action:'owner',reason:'site_blocked',episode:episodeNow};
  if(site==='down')return {action:'site_down',episode:{...episodeNow,siteDownSince:episodeNow.siteDownSince||now}};
 }
 // Any intervention in the ledger, or a bot/Chrome start by anyone (a deploy
 // or a Codex repair that took no lock), gets five quiet minutes first.
 const lastAny=Math.max(0,...ledger.map(e=>e.at),...Object.values(services).map(s=>s?.startedAt||0));
 if(now-lastAny<LIMITS.settleMs)return {action:'settling',episode:episodeNow};
 const auto=ledger.filter(e=>AUTOMATIC.has(e.actor)&&RESTARTS.has(e.action));
 if(auto.filter(e=>now-e.at<3600_000).length>=LIMITS.perHour||auto.filter(e=>now-e.at<86400_000).length>=LIMITS.perDay)
  return {action:'limit',notify:!episodeNow.limitNotified,episode:{...episodeNow,limitNotified:true}};
 // A hung bot does not answer its own health check: restart both. Otherwise
 // Chrome first, both if Chrome alone did not bring the reads back.
 const step=!healthOk||failed.includes('bot')||episodeNow.actions.some(a=>a.action==='restart_browser')?'restart_all':'restart_browser';
 return {action:step,reason:failed.length?'failed:'+failed.join(','):site==='up'?'site_up_no_reads':'no_reads',episode:{...episodeNow,actions:[...episodeNow.actions,{action:step,at:now}]}};
}

const clock=ms=>new Date(ms).toLocaleTimeString('tr-TR',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',hour12:false});
export function noticeText(decision){
 if(decision.action==='recovered'){
  const {since,actions,at}=decision.recovered,what=actions.some(a=>a.action==='restart_all')?'Chrome ve bot yeniden başlatıldı':'Chrome yeniden başlatıldı';
  return `🔧 Bekçi: okuma ${clock(since)}–${clock(at)} arası durmuştu. Site yanıt verince ${what}; yeni tesis okumaları geldi, takip normale döndü.`;
 }
 if(decision.action==='limit')return `⚠️ Bekçi: okuma ${clock(decision.episode.since)}'ten beri durmuş. Site açık ama otomatik toparlama sınırı doldu (saatte ${LIMITS.perHour}, günde ${LIMITS.perDay}). Codex ya da Claude'un bakması gerekiyor.`;
 return null;
}

// ---- runner (root, on the VPS) ----
// The watchdog may run from its own folder, outside the release it watches.
const PRIVATE='/var/lib/odtu-rez/private',CURRENT='/opt/odtu-rez/current';
// systemd start times are monotonic microseconds; /proc/uptime gives the same clock now.
const monotonicNowMs=()=>Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000;
const loadJson=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
function runtimeEnv(){
 const env={};try{for(const line of readFileSync(join(PRIVATE,'runtime.env'),'utf8').split('\n'))if(line.includes('=')&&!line.startsWith('#')){const i=line.indexOf('=');env[line.slice(0,i)]=line.slice(i+1);}}catch{}
 return env;
}
function serviceStates(){
 return Object.fromEntries(Object.entries(SERVICES).map(([name,unit])=>{
  const out=execFileSync('systemctl',['show',unit,'-p','ActiveState','-p','Result','-p','ActiveEnterTimestampMonotonic'],{encoding:'utf8'});
  const v=Object.fromEntries(out.trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
  const entered=Number(v.ActiveEnterTimestampMonotonic)/1000;
  return [name,{active:v.ActiveState,result:v.Result,startedAt:entered>0?Date.now()-(monotonicNowMs()-entered):0}];
 }));
}
async function health(){
 try{const key=readFileSync(join(PRIVATE,'ingest.key'),'utf8').trim();
  const r=await fetch('http://127.0.0.1:8765/health',{headers:{'X-Local-Key':key},signal:AbortSignal.timeout(5000)});
  return r.ok?await r.json():null;}catch{return null;}
}
export async function probeSite(fetchImpl=fetch){
 try{const r=await fetchImpl('https://rez.metu.edu.tr/view/home.jsf',{redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(r.status===403||r.status===429)return 'blocked';
  // An answering web server is not necessarily a working reservation app.
  // Payara's 404 during a deployment must not trigger browser/bot restarts.
  return r.status>=200&&r.status<400?'up':'down';}catch{return 'down';}
}
async function notify(text){
 const env=runtimeEnv(),tokenFile=env.REZ_OPERATOR_BOT_TOKEN_FILE;if(!tokenFile)return 'not_configured';
 const token=readFileSync(tokenFile,'utf8').trim(),owner=readFileSync(join(PRIVATE,'owner-chat-id'),'utf8').trim();
 let publicToken='';try{publicToken=readFileSync(join(PRIVATE,'telegram-token'),'utf8').trim();}catch{}
 // Technical notices never use the public bot.
 if(!token||token===publicToken||!/^[1-9]\d{0,19}$/.test(owner))return 'refused';
 try{const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({chat_id:owner,text}),signal:AbortSignal.timeout(10000)});return r.ok?'accepted':'rejected:'+r.status;}catch{return 'uncertain';}
}
function restart(step){
 if(step==='restart_all')execFileSync('systemctl',['restart',SERVICES.bot]);
 execFileSync('systemctl',['restart',SERVICES.browser]);
}
async function run({dry=false}={}){
 const now=Date.now(),stateFile=join(PRIVATE,'watchdog.json'),saved=loadJson(stateFile)||{};
 const h=await health(),state=loadJson(join(PRIVATE,'state.json'))||{};
 const pages=Object.values(state.engine?.pages||{}),readAt=p=>Date.parse(p?.lastSuccessAt||'')||0;
 const services=serviceStates(),rawWait=isPublicationWait({state,now});
 const publication=publicationWindow({rawWait,state,reader:h?.reader,services,healthOk:!!h,now,previous:saved.publicationWait});
 const configFile=(runtimeEnv().REZ_READER_CONFIG_FILES||join(CURRENT,'extension/local-config.json')).split(':')[0];
 const input={now,services,healthOk:!!h,reader:h?.reader||null,maintenance:loadJson(configFile)?.maintenance===true,
  publicationWait:publication.waiting,lastReadAt:Math.max(0,...pages.map(readAt)),readsSince:ts=>new Set(pages.filter(p=>readAt(p)>ts).map(p=>String(p.facility?.id))).size,
  hold:activeHold(PRIVATE,now),lock:(l=>l&&l.owner!=='watchdog'?l:null)(activeLock(PRIVATE,now)),ledger:readLedger(PRIVATE,86400_000,now),episode:saved.episode||null};
 let decision=decide(input);
 if(decision.action==='probe')decision=decide({...input,site:await probeSite(),episode:decision.episode});
 // check: what it would do now, without acting, notifying or saving.
 if(dry){console.log(JSON.stringify({action:decision.action,reason:decision.reason||null,quietMinutes:Math.round((now-input.lastReadAt)/60000),phase:input.reader?.phase||null,hold:input.hold,lock:input.lock}));return;}
 let notice=null;
 if(decision.action==='restart_browser'||decision.action==='restart_all'){
  if(!acquireLock(PRIVATE,'watchdog',LIMITS.settleMs,decision.reason,now))decision={...decision,action:'locked',episode:{...decision.episode,actions:decision.episode.actions.slice(0,-1)}};
  else{appendLedger(PRIVATE,{actor:'watchdog',action:decision.action,reason:decision.reason},now);
   try{restart(decision.action);}catch{appendLedger(PRIVATE,{actor:'watchdog',action:'restart_failed',reason:decision.action});}}
 }
 if(decision.action==='recovered'){appendLedger(PRIVATE,{actor:'watchdog',action:'recovered',reason:'new_reads'},now);releaseLock(PRIVATE,'watchdog');}
 const changed=saved.lastDecision?.action!==decision.action||(saved.lastDecision?.reason??null)!==(decision.reason??null);
 const next=await deliverWatchdogNotice({file:stateFile,decision,now,state:{...saved,lastRunAt:now,
  lastDecision:{action:decision.action,reason:decision.reason||null,at:changed?now:saved.lastDecision?.at||now},
  episode:decision.episode||null,publicationWait:publication.mark,lastNotice:saved.lastNotice||null},
  readsSince:ts=>new Set(pages.filter(p=>state.readerPlan?.dates?.includes(p.date)&&readAt(p)>ts&&readAt(p)<=now).map(p=>String(p.facility?.id))).size,send:notify});
 if(next.lastNotice!==saved.lastNotice)notice=next.lastNotice;
 if(changed||notice)console.log(`bekçi: ${decision.action}${decision.reason?' ('+decision.reason+')':''}${notice?' bildirim='+notice.result:''}`);
 saveWatchdog(stateFile,next);
}
function status(){
 const now=Date.now();
 console.log(JSON.stringify({watchdog:loadJson(join(PRIVATE,'watchdog.json')),hold:activeHold(PRIVATE,now),lock:activeLock(PRIVATE,now),
  ledger:readLedger(PRIVATE,7*86400_000,now).slice(-15)},null,1));
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const [cmd,a,b,...rest]=process.argv.slice(2),minutes=n=>Math.min(24*60,Math.max(1,Number(n)||30))*60_000;
 if(cmd==='run')await run();
 else if(cmd==='check')await run({dry:true});
 else if(cmd==='status')status();
 // For Codex/Claude repairs and deploys: lock <owner> <minutes> [reason] / unlock <owner>
 else if(cmd==='lock'){const ok=acquireLock(PRIVATE,a,minutes(b),rest.join(' '));if(ok)appendLedger(PRIVATE,{actor:a,action:'lock',reason:rest.join(' ').slice(0,120)});console.log(ok?'locked':'busy');process.exitCode=ok?0:1;}
 else if(cmd==='unlock')console.log(releaseLock(PRIVATE,a)?'unlocked':'not_held');
 // Maintenance: hold <minutes> [reason] / release-hold. The watchdog only observes.
 else if(cmd==='hold'){setHold(PRIVATE,process.env.SUDO_USER||'operator',minutes(a),[b,...rest].join(' '));appendLedger(PRIVATE,{actor:'operator',action:'hold',reason:[b,...rest].join(' ').slice(0,120)});console.log('held');}
 else if(cmd==='release-hold')console.log(clearHold(PRIVATE)?'released':'no_hold');
 else{console.error('usage: watchdog.mjs run|check|status|lock <owner> <min> [reason]|unlock <owner>|hold <min> [reason]|release-hold');process.exitCode=2;}
}
