import {msg,locale,withLanguage,facilityLabel} from './i18n.mjs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {subscriptionMatches} from './core.mjs';
const RETAIN_MS=24*60*60_000;
const STALE_MS=60_000;
const MISSING_WINDOW_MS=180_000;
// Give acknowledgements the normal bounded send window. A slow response is
// not a reason to replay a request that Telegram may already have accepted.
const SLOT_RESPONSE_TIMEOUT_MS=20_000;
export const slotAlertKey=a=>createHash('sha256').update(`${a.chatId}|${a.facilityId}|${a.date}|${a.start}|${a.end}`).digest('hex').slice(0,32);
const positiveId=id=>Number.isSafeInteger(id)&&id>0;
// Only fixed categories are persisted. Raw errors may contain personal data.
function uncertainDeliveryCode(error){
 const status=error?.status;
 if(status===408)return 'http_408';
 if(Number.isInteger(status)&&status>=500&&status<600)return 'http_5xx';
 if(Number.isInteger(status)&&status>=200&&status<300)return 'invalid_response';
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'timeout';
 return 'network_or_unknown';
}
const shortName=label=>/baraka.*fitness/i.test(label)?'Baraka Fitness':/ODTÜ Spor Merkezi.*Fitness/i.test(label)?'Teknokent Fitness':facilityLabel(label).slice(0,38);
const when=date=>new Intl.DateTimeFormat(locale(),{timeZone:'Europe/Istanbul',day:'numeric',month:'short',weekday:'short'}).format(new Date(`${date}T12:00:00Z`));
// Booking and cancelling stay on the official site; the bot only links to it.
export const siteKeyboard=()=>({inline_keyboard:[[{text:msg('🌐 Siteyi aç · rezervasyon / iptal','🌐 Open the site · book / cancel'),url:'https://rez.metu.edu.tr/',style:'primary'}]]});
// Short, separate messages: one when a place opens, one when it fills.
// An earlier message is never rewritten, so what someone read stays true
// for the moment it was sent.
export function formatSlotStatus(alert,label,preferredLanguage='tr'){
 return withLanguage(preferredLanguage,()=>{
  const where=`${shortName(label)} · ${when(alert.date)} ${alert.start}–${alert.end}`;
  if(alert.status==='available')return [msg(`🟢 Yer açıldı · Boş yer: ${alert.free}`,`🟢 A place is available · Free places: ${alert.free}`),where].join('\n');
  if(['full','unlisted'].includes(alert.status))return [msg('🔴 Doldu','🔴 Full now'),where].join('\n');
  if(alert.status==='expired')return [msg('⏰ Rezervasyon süresi geçti','⏰ Booking has closed'),where].join('\n');
  return [msg('⚪ Güncel bilgi yok','⚪ No current information'),where].join('\n');
 });
}

function queue(store,alert,status,free,observedAt,notify=false){
 const jobs=store.state.slotStatusJobs??={};const pending=jobs[alert.key];
 const unchanged=alert.status===status&&alert.free===free;
 alert.status=status;alert.free=free;alert.observedAt=observedAt;
 if(alert.rejectedStatus===status)return false;
 delete alert.rejectedStatus;
 if(pending&&pending.status===status&&pending.free===free)return false;
 if(unchanged&&Date.now()-(alert.lastRenderedAt||0)<60_000)return false;
 alert.revision=(alert.revision||0)+1;
 jobs[alert.key]={key:alert.key,revision:alert.revision,status,free,observedAt,notify,notifyState:'pending',editDone:false,nextAt:Date.now(),attempts:0};return true;
}
export function rememberSlotAlert(store,item,messageId){
 const e=item.event;if(!e?.facility||!e.date||!e.start||!e.end||!Number.isFinite(e.free))return;
 const alert={chatId:String(item.chatId),facilityId:String(e.facility.id),date:e.date,start:e.start,end:e.end};alert.key=slotAlertKey(alert);
 const alerts=store.state.slotAlerts??={};
 alerts[alert.key]={...alert,messageId:positiveId(messageId)?messageId:null,status:'available',free:e.free,observedAt:e.observedAt,lastObservedAt:e.observedAt,lastRenderedAt:Date.now(),revision:(alerts[alert.key]?.revision||0)+1,missingCount:0,
  // What this chat last heard about the session: the next message must say the opposite.
  lastNotified:'available'};
 if(store.state.slotStatusJobs)delete store.state.slotStatusJobs[alert.key];
}
// Adopt active old alerts for follow-up notifications. Their old Telegram
// message IDs were not retained, so they cannot be edited retroactively.
function adoptOldAlerts(store){
 const alerts=store.state.slotAlerts??={};
 const sentIds=new Set(store.state.outbox.filter(d=>d.status==='sent').map(d=>d.id));
 const allowed=new Map();
 for(const sub of store.state.subscriptions){
  if(!sub.date)continue;
  if(!allowed.has(sub.chatId))allowed.set(sub.chatId,store.isChatAllowed(sub.chatId));
  if(!allowed.get(sub.chatId))continue;
  for(const [slot,c] of Object.entries(sub.availabilityChecks||{})){
   const [start,end]=slot.split('|');if(!/^\d{2}:\d{2}$/.test(start||'')||!/^\d{2}:\d{2}$/.test(end||''))continue;
   const alert={chatId:sub.chatId,facilityId:sub.facilityId,date:sub.date,start,end};alert.key=slotAlertKey(alert);
   if(alerts[alert.key]||store.isSlotClosed(alert)||!sentIds.has(c.queuedId))continue;
   alerts[alert.key]={...alert,messageId:null,status:'available',free:null,lastObservedAt:null,observedAt:new Date().toISOString(),lastRenderedAt:Date.now(),revision:0,missingCount:0};
  }
 }
}
// Build this once per synchronous observation, not once per alert. The
// live subscription object is re-read for each new batch / after async work.
function watchedPredicate(store){
 const byChat=new Map(),allowed=new Map();
 for(const sub of store.state.subscriptions){
  if(sub.active===false)continue;
  if(!allowed.has(sub.chatId))allowed.set(sub.chatId,store.isChatAllowed(sub.chatId));
  if(!allowed.get(sub.chatId))continue;
  const key=`${sub.chatId}|${sub.facilityId}`;
  (byChat.get(key)||byChat.set(key,[]).get(key)).push(sub);
 }
 return alert=>store.catalogFacility(alert.facilityId)?.enabled!==false&&(byChat.get(`${alert.chatId}|${alert.facilityId}`)||[])
  .some(sub=>subscriptionMatches(sub,{facility:{id:alert.facilityId},date:alert.date,start:alert.start,end:alert.end}));
}
export function observeSlotAlerts(store,observation){
 adoptOldAlerts(store);
 if(observation.state!=='ok'||!observation.fresh)return;
 const now=Date.parse(observation.observedAt);if(Date.now()-now>10_000)return;
 const watched=watchedPredicate(store),slots=new Map(observation.slots.map(s=>[`${s.start}|${s.end}`,s]));
 for(const alert of Object.values(store.state.slotAlerts||{})){
  if(alert.facilityId!==observation.facility.id||alert.date!==observation.date||!watched(alert))continue;
  if(alert.lastRefreshId===observation.refreshId)continue;
  alert.lastRefreshId=observation.refreshId;alert.lastObservedAt=observation.observedAt;
  // Messages alternate: "Doldu" only after this chat was told "Yer açıldı",
  // and a new "Yer açıldı" only after "Doldu". Alerts from older versions have
  // no record of what was last said, so they stay quiet.
  if(store.isSlotClosed(alert,now)){queue(store,alert,'expired',null,observation.observedAt,false);continue;}
  const slot=slots.get(`${alert.start}|${alert.end}`);
  if(slot){
   alert.missingCount=0;delete alert.missingAt;
   queue(store,alert,slot.free>0?'available':'full',slot.free,observation.observedAt,
    slot.free>0?alert.lastNotified==='full':alert.lastNotified==='available');
  }else{
   if(alert.status==='full'||alert.status==='unlisted')continue;
   // Consecutive reads of one facility can be more than a minute apart; a
   // 60-second window meant some courts never got their "Doldu".
   alert.missingCount=alert.missingAt&&now-alert.missingAt<=MISSING_WINDOW_MS?(alert.missingCount||0)+1:1;alert.missingAt=now;
   // The site lists only sessions with places; two misses in a row mean it filled.
   queue(store,alert,alert.missingCount>=2?'unlisted':'checking',null,observation.observedAt,alert.missingCount>=2&&alert.lastNotified==='available');
  }
 }
}
export function ageSlotAlerts(store,now=Date.now()){
 let changed=false;const watched=watchedPredicate(store);
 for(const alert of Object.values(store.state.slotAlerts||{})){
  if(!watched(alert)){if(store.state.slotStatusJobs?.[alert.key]){delete store.state.slotStatusJobs[alert.key];changed=true;}continue;}
  if(store.isSlotClosed(alert,now)){
   if(alert.status!=='expired')changed=queue(store,alert,'expired',null,new Date(now).toISOString(),false)||changed;
  }else if(now-Date.parse(alert.lastObservedAt||'')>STALE_MS&&!['stale','expired'].includes(alert.status))changed=queue(store,alert,'stale',null,new Date(now).toISOString(),false)||changed;
 }
 return changed;
}
export function pruneSlotAlerts(store,now=Date.now()){
 const alerts=store.state.slotAlerts||{},jobs=store.state.slotStatusJobs||{};
 for(const [key,a]of Object.entries(alerts))if(now-Date.parse(`${a.date}T23:59:00+03:00`)>RETAIN_MS){delete alerts[key];delete jobs[key];}
 // Live follow-up state must survive for every watched session. A global
 // count cap silently deleted valid chats and their pending Full messages.
 // Retention is dated; deleted subscriptions already stop jobs above.
}
export function recoverSlotAlerts(store){
 let changed=false;
 for(const job of Object.values(store.state.slotStatusJobs||{}))if(job.notifyState==='sending'){job.notifyState='uncertain';changed=true;}
 if(changed){store.state.slotUpdateUncertainAt=new Date().toISOString();store.state.slotUpdateUncertainCode='interrupted';}
 return changed;
}
export async function flushSlotUpdates(store,api,{max=100,concurrency=8}={}){
 if(ageSlotAlerts(store))store.save();
 let handled=0,blocked=false;const gone=new Set();
 while(handled<max&&!blocked){
  if(Date.now()<Number(store.state.deliveryBlockedUntil||0))break;
  const round=[],chats=new Set();let changed=false;
  for(const initial of Object.values(store.state.slotStatusJobs||{})){
   if(handled+round.length>=max||round.length>=25)break;
   const alert=store.state.slotAlerts?.[initial.key],job=store.state.slotStatusJobs?.[initial.key];
   if(!alert||!job||job.nextAt>Date.now()||chats.has(alert.chatId))continue;
   const allowed=job.status==='available'?alert.lastNotified==='full':['full','unlisted'].includes(job.status)?alert.lastNotified==='available':false;
   if(!store.isSlotWatched(alert)||!job.notify||!allowed||job.notifyState!=='pending'){
    delete store.state.slotStatusJobs[initial.key];changed=true;handled++;continue;
   }
   chats.add(alert.chatId);
   const view={...alert,status:job.status,free:job.free,observedAt:job.observedAt};
   const text=formatSlotStatus(view,store.catalogFacility(alert.facilityId)?.label||alert.facilityId,store.languageFor?.(alert.chatId)||'tr');
   job.previousNotified=alert.lastNotified;job.notifyState='sending';alert.lastNotified=job.status==='available'?'available':'full';
   round.push({initial,alert,job,text,revision:alert.revision,reopened:job.status==='available',started:false});changed=true;
  }
  if(changed)store.save();
  if(!round.length)break;
  let cursor=0;
  const current=r=>store.state.slotStatusJobs?.[r.initial.key]?.revision===r.revision;
  async function worker(){
   while(!blocked&&cursor<round.length){
    const r=round[cursor++];r.started=true;const {alert,job,reopened}=r;
    // A person may cancel while another chat's request is in flight.
    // Recheck just before starting this transport, not only at batch setup.
    if(!store.isSlotWatched(alert)){
     if(current(r)){alert.lastNotified=job.previousNotified;delete store.state.slotStatusJobs[r.initial.key];}
     handled++;continue;
    }
    const attemptStartedAt=performance.now();
    try{
     const markup=reopened?withLanguage(store.languageFor?.(alert.chatId)||'tr',siteKeyboard):undefined;
     const replyTo=reopened?null:alert.messageId;
     let result;
     try{result=await api.sendMessage(alert.chatId,r.text,markup,SLOT_RESPONSE_TIMEOUT_MS,replyTo);}
     catch(error){
      // The rejected reply is safe to send on its own while it is still current.
      if(!positiveId(replyTo)||!error.replyTargetMissing||!current(r)||!store.isSlotWatched(alert)||store.isSlotClosed(alert))throw error;
      result=await api.sendMessage(alert.chatId,r.text,markup,SLOT_RESPONSE_TIMEOUT_MS,null);
     }
     if(reopened&&positiveId(result?.message_id))alert.messageId=result.message_id;
     alert.lastRenderedAt=Date.now();if(current(r))delete store.state.slotStatusJobs[r.initial.key];
    }catch(error){
     const status=error.status;
     const rejected=Number.isInteger(status)&&status>=400&&status<500&&status!==408;
     if(rejected)alert.lastNotified=job.previousNotified;
     if(error.chatGone)gone.add(String(alert.chatId));
     else if(status===429){
      blocked=true;store.deferQueuedUntil(Date.now()+Math.max(5000,error.retryAfterMs||30000));
     }else{
      store.noteTelegramError(status);
      const at=new Date().toISOString();
      if(rejected){
       const reason=error.replyTargetMissing?'reply_target_missing':`http_${status}`;
       if(current(r))alert.rejectedStatus=job.status;
       store.state.slotUpdateFailedAt=at;
       store.state.slotUpdateFailureCode=reason;
       console.error(`${at} REZ_SLOT_DELIVERY rejected ${reason}`);
      }else {
       const reason=uncertainDeliveryCode(error);
       store.state.slotUpdateUncertainAt=at;store.state.slotUpdateUncertainCode=reason;
       // Fixed categories and timing only: no recipient, message or raw error.
       const elapsed=Math.max(0,Math.round(performance.now()-attemptStartedAt));
       console.error(`${at} REZ_SLOT_DELIVERY uncertain ${reason} attempt_ms=${elapsed} response_timeout_ms=${SLOT_RESPONSE_TIMEOUT_MS}`);
      }
     }
     if(current(r)){
      if(status===429){job.notifyState='pending';job.nextAt=store.state.deliveryBlockedUntil;}
      else delete store.state.slotStatusJobs[r.initial.key];
     }
    }
    handled++;
   }
  }
  // One job per chat in a round; durable intent before I/O and one commit
  // after it. The shared TelegramApi limiter still caps total bot traffic.
  await Promise.all(Array.from({length:Math.max(1,Math.min(concurrency,round.length))},worker));
  for(const r of round)if(!r.started&&current(r)){r.alert.lastNotified=r.job.previousNotified;r.job.notifyState='pending';r.job.nextAt=Number(store.state.deliveryBlockedUntil)||Date.now();}
  store.save();
  // Same rule as new alerts: a chat that blocked the bot is forgotten.
  for(const chat of gone)store.forgetChat(chat);gone.clear();
 }
 return handled;
}
export async function runSlotUpdateLoop(store,api,signal){
 while(!signal.aborted){try{await flushSlotUpdates(store,api);}catch(error){store.noteTelegramError(error.status);console.error(`${new Date().toISOString()} Telegram seans durumu güncellenemedi`);}if(!signal.aborted)await delay(1000,undefined,{signal}).catch(()=>{});}
}
