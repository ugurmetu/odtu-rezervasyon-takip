import {msg,locale,language,withLanguage,withChatLanguage,facilityLabel} from './i18n.mjs';
import {canSelectFacility,requestFacility} from './reader-facilities.mjs';
import {sessionRegistrationClosed} from './store.mjs';

const button=(text,callback_data,style)=>({text,callback_data,...(style?{style}:{})});
const reply=(chatId,text,rows)=>({chatId,text,replyMarkup:{inline_keyboard:rows}});
const home=()=>button(msg('🏠 Ana menü',"🏠 Main menu"),'h');
const compact=date=>date.replaceAll('-','');
const expand=code=>`${code.slice(0,4)}-${code.slice(4,6)}-${code.slice(6,8)}`;
const cleanFilter=({date,startAfter,endBefore,notifyAvailable,exactTime})=>({
  ...(date?{date}:{}),...(startAfter?{startAfter}:{}),...(endBefore?{endBefore}:{}),
  ...(notifyAvailable?{notifyAvailable:true}:{}),...(exactTime?{exactTime:true}:{})});

export function facilityEmoji(label){
  if(/masa.*tenis/i.test(label))return '🏓';
  if(/fitness|ağırlık|kondisyon/i.test(label))return '🏋️';
  if(/tenis|padel/i.test(label))return '🎾';
  if(/havuz|yüzme/i.test(label))return '🏊';
  if(/basket/i.test(label))return '🏀';
  if(/voley/i.test(label))return '🏐';
  if(/futbol|halı saha/i.test(label))return '⚽';
  return '🏟️';
}
export function shortFacilityName(label=''){
  if(/baraka.*fitness/i.test(label))return 'Baraka Fitness';
  if(/ODTÜ Spor Merkezi.*Fitness/i.test(label))return 'Teknokent Fitness';
  if(/tenis.*kort|kort.*tenis/i.test(label)){const n=label.match(/(\d+)\s*(?:Nolu|No['’]?lu)\b|Kort\s*(\d+)/i);return msg(`${n?.[1]||n?.[2]||''}. ${/kapalı/i.test(label)?'Kapalı ':''}Kort · ${/Büyük Spor/i.test(label)?'Büyük Spor':'Merkez'}`,`${/kapalı/i.test(label)?'Indoor ':''}Court ${n?.[1]||n?.[2]||''} · ${/Büyük Spor/i.test(label)?'Main Hall':'Central'}`);}
  return facilityLabel(label).replace(/^(?:ODTÜ|METU)\s+/, '').replace(/\s*-\s*/g,' ').slice(0,32);
}
export function shortDateLabel(date){
  return new Intl.DateTimeFormat(locale(),{timeZone:'Europe/Istanbul',day:'numeric',month:'short',weekday:'short'})
    .format(new Date(`${date}T12:00:00Z`));
}
export function dateLabel(date){
  return new Intl.DateTimeFormat(locale(),{timeZone:'Europe/Istanbul',day:'numeric',month:'long',weekday:'long'})
    .format(new Date(`${date}T12:00:00Z`));
}
function today(now){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date(now)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const WEEK_ROLLOVER='19:30';
export function pickerDates(now=Date.now()){
  let start=Date.parse(`${today(now)}T12:00:00Z`);
  const weekday=new Date(start).getUTCDay();
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(now));
  // The next week is published on Sunday evening at a varying time (around
  // 20:00-21:10). From 19:30 the reader and the menu move to the next week, so
  // its publication is seen at once. Earlier in the week, never advertise next
  // Monday/Tuesday merely to fill a seven-day rolling window.
  if(weekday===0&&time>=WEEK_ROLLOVER)start+=86400000;
  const days=8-(new Date(start).getUTCDay()||7);
  return Array.from({length:days},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10));
}
const facility=(store,id)=>store.availableFacilities().find(f=>f.id===id);
const dayFilters=(store,chatId,id,date)=>store.filtersFor(chatId,id).filter(f=>f.date===date);
function monitored(store,id,date){
  return !store.state.readerPlan || (store.state.readerPlan.facilityIds.includes(id)&&store.state.readerPlan.dates.includes(date));
}
export function dayMenu(store,chatId,id,now=Date.now()){
 return withChatLanguage(store,chatId,()=>dayMenuInLanguage(store,chatId,id,now));
}
function dayMenuInLanguage(store,chatId,id,now){
  const f=facility(store,id);if(!f)return null;
  if(store.accessMode==='public'&&!canSelectFacility(store,id))return reply(chatId,`${facilityEmoji(f.label)} ${shortFacilityName(f.label)}\n\n${msg('Bu tesis henüz takip edilmiyor.','This facility is not being monitored yet.')}`,[[button(msg('⬅️ Tesisler',"⬅️ Facilities"),`back:${id}`),button(msg('🔔 Seçimlerim',"🔔 My selections"),'p')],[home()]]);
  if(store.accessMode==='public')requestFacility(store,id,now);
  const rows=pickerDates(now).map(date=>{const chosen=dayFilters(store,chatId,id,date).length>0;return [button(`${!monitored(store,id,date)&&!canSelectFacility(store,id)?'⏸':chosen?'🔔':'📅'} ${dateLabel(date)}`,`d:${id}:${compact(date)}`,chosen?'success':undefined)];});
  rows.push([button(msg('⬅️ Tesisler',"⬅️ Facilities"),`back:${id}`),button(msg('🔔 Seçimlerim',"🔔 My selections"),'p')],[home()]);
  const paused=rows.some(row=>row[0]?.text?.startsWith('⏸'));
  return reply(chatId,`${facilityEmoji(f.label)} ${shortFacilityName(f.label)}\n\n${msg('Hangi gün?','Which day?')}${paused?`\n${msg('⏸ işaretli günler henüz takip edilmiyor.','Days marked ⏸ are not monitored yet.')}`:''}`,rows);
}

function officialSessions(store,id,date) {
  const catalog=store.state.sessionCatalog?.[`${id}|${date}`];
  return ['official-booking-form','weekly-publication'].includes(catalog?.source) && Array.isArray(catalog.sessions) && catalog.sessions.length ? catalog.sessions : null;
}
// The site lists only sessions that still have places, so a full session is
// invisible. Times seen earlier for this date, or on the same weekday in the
// previous weeks, stay selectable so someone can wait for a place to open.
const WEEK_MS=7*24*60*60_000;
function usualSessionKeys(store,id,date){
  const day=Date.parse(`${date}T12:00:00Z`),keys=new Set();
  for(let weeks=1;weeks<=6;weeks++){
    const prior=new Date(day-weeks*WEEK_MS).toISOString().slice(0,10);
    for(const key of Object.keys(store.engine.pages[`${id}|${prior}`]?.slots||{})){
      const [,start,end]=key.split('|');keys.add(`${date}|${start}|${end}`);
    }
  }
  return keys;
}
// Facilities opened in the menu are read first, so counts up to 15 minutes old
// are still shown; older ones show as being refreshed, without alarm.
// Until a full week has been seen, a day's missing hours are estimated from
// the same facility's most similar day (most shared session times). Only
// times that do not overlap a known session are added; a day with no known
// session (a holiday, a closed day) gets no estimate.
function inferredSessionKeys(store,id,date,known){
  if(!known.size)return new Set();
  const day=Date.parse(`${date}T12:00:00Z`),templates=new Map();
  for(const [key,page] of Object.entries(store.engine.pages||{})){
    const [fid,other]=key.split('|');
    if(fid!==id||other===date)continue;
    const at=Date.parse(`${other}T12:00:00Z`);
    if(!Number.isFinite(at)||Math.abs(at-day)>42*24*60*60_000)continue;
    const weekday=new Date(at).getUTCDay(),times=templates.get(weekday)||templates.set(weekday,new Set()).get(weekday);
    for(const slot of Object.keys(page?.slots||{})){const [,start,end]=slot.split('|');if(/^\d{2}:\d{2}$/.test(start)&&/^\d{2}:\d{2}$/.test(end))times.add(`${start}|${end}`);}
  }
  const knownTimes=[...known].map(key=>key.split('|').slice(1));
  let best=null,score=0;
  for(const times of templates.values()){
    const shared=knownTimes.filter(([start,end])=>times.has(`${start}|${end}`)).length;
    if(shared>score||(shared===score&&shared>0&&times.size>best.size)){best=times;score=shared;}
  }
  if(!best)return new Set();
  const overlaps=(start,end)=>knownTimes.some(([a,b])=>start<b&&a<end);
  return new Set([...best].filter(time=>{const [start,end]=time.split('|');return !overlaps(start,end);}).map(time=>`${date}|${time}`));
}
export function sessionOptions(store,id,date,now=Date.now()){
  const page=store.engine.pages[`${id}|${date}`];
  const seen=new Set(page?.observedSlotKeys||Object.keys(page?.slots||{}));
  const age=now-Date.parse(page?.lastSuccessAt||'');
  const fresh=age>=0&&age<=15*60000;
  const definitions=officialSessions(store,id,date);
  const newerThanCatalog=Date.parse(page?.lastSuccessAt||'')>Date.parse(store.state.sessionCatalog?.[`${id}|${date}`]?.verifiedAt||'');
  const retained=new Set(Object.keys(page?.slots||{}));
  const official=new Set(definitions?definitions.map(s=>`${date}|${s.start}|${s.end}`):[]);
  const usual=usualSessionKeys(store,id,date);
  const known=new Set([...retained,...usual]);
  const inferred=definitions?new Set():inferredSessionKeys(store,id,date,known);
  const keys=definitions ? [...new Set([...official,...(fresh&&newerThanCatalog?[...seen]:[])])] : [...new Set([...known,...inferred])];
  return keys.flatMap(key=>{
    const [day,start,end]=key.split('|');
    if(day!==date||!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)
      ||sessionRegistrationClosed({date,start,end},facility(store,id)?.unit,now))return [];
    const current=fresh&&seen.has(key);
    const source=current?'current':retained.has(key)||official.has(key)?'seen':usual.has(key)?'usual':'inferred';
    return [{start,end,current,source,free:current?page.slots[key]?.free:null}];
  }).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end)).slice(0,40);
}
export function sessionMenu(store,chatId,id,date,now=Date.now()){
 return withChatLanguage(store,chatId,()=>sessionMenuInLanguage(store,chatId,id,date,now));
}
function sessionMenuInLanguage(store,chatId,id,date,now){
  const f=facility(store,id);if(!f)return null;
  if(!pickerDates(now).includes(date))return dayMenu(store,chatId,id,now);
  if(store.accessMode==='public'&&!canSelectFacility(store,id))return reply(chatId,`${facilityEmoji(f.label)} ${shortFacilityName(f.label)}\n${shortDateLabel(date)}\n\n${msg('Bu tesis/gün henüz takip edilmiyor.','This facility/day is not being monitored yet.')}`,[[button(msg('⬅️ Günler',"⬅️ Days"),`t:${id}`),button(msg('🔔 Seçimlerim',"🔔 My selections"),'p')],[home()]]);
  if(store.accessMode==='public')requestFacility(store,id,now);
  const filters=dayFilters(store,chatId,id,date);
  const all=filters.some(f=>!f.startAfter&&!f.endBefore);
  const options=sessionOptions(store,id,date,now);
  const definitions=officialSessions(store,id,date);
  const active=monitored(store,id,date);
  const page=store.engine.pages[`${id}|${date}`];
  const age=now-Date.parse(page?.lastSuccessAt||'');
  const fresh=age>=0&&age<=15*60000;
  // Hours learned from this date or earlier weeks are shown as plain session
  // times; the user only needs to know whether a place is free right now.
  const state=({source,free})=>source==='current'?msg(`🟢 ${free} boş`,`🟢 ${free} free`):msg('⚪ şu an boş yer yok','⚪ no free place now');
  const rows=options.map(option=>{
    const {start,end}=option;
    const enabled=filters.some(f=>f.exactTime&&f.startAfter===start&&f.endBefore===end);
    return [button(all?msg(`Yalnız ${start}–${end} · ${state(option)}`,`Only ${start}–${end} · ${state(option)}`):`${enabled?'✅':'▫️'} ${start}–${end} · ${fresh?state(option):msg('🔄 yenileniyor','🔄 refreshing')}`,`q:${id}:${compact(date)}:${start.replace(':','')+end.replace(':','')}:${enabled?'0':'1'}`,enabled?'success':undefined)];
  });
  for(const saved of filters.filter(f=>f.exactTime&&!options.some(s=>s.start===f.startAfter&&s.end===f.endBefore))){
    const code=saved.startAfter.replace(':','')+saved.endBefore.replace(':','');
    rows.push([button(`✅ ${saved.startAfter}–${saved.endBefore} · ${msg('kayıtlı','saved')}`, `q:${id}:${compact(date)}:${code}:0`,'success')]);
  }
  rows.push([button(all?msg('✅ Bütün gün izleniyor · kapatmak için dokun',"✅ Watching all day · tap to turn off"):msg('🔔 Günün tamamını izle',"🔔 Watch all sessions for this day"),`da:${id}:${compact(date)}:${all?'0':'1'}`,all?'success':undefined)]);
  rows.push([button(msg('⬅️ Günler',"⬅️ Days"),`t:${id}`),button(msg('🔔 Seçimlerim',"🔔 My selections"),'p')]);
  const lines=[options.length?msg('Haber almak istediğin saatleri seç.',"Choose the sessions you want an alert for."):fresh&&active?msg('Şu an bu gün için sitede boş yeri olan seans yok.',"The site lists no session with free places for this day right now."):msg('Bu günün seans listesi henüz doğrulanmadı.',"The session list for this day has not been verified yet.")];
  lines.push('',msg('Site dolu seansları göstermez. Saatin yoksa “Günün tamamını izle”yi seç.',"The site hides full sessions. If your time is missing, choose “Watch all sessions”."));
  if(options.some(o=>o.source==='inferred'))lines.push(msg('Bazı saatler diğer günlerden tahmin edildi.',"Some times are estimated from other days."));
  if(!active)lines.push(canSelectFacility(store,id)?msg('⏳ Takvim sıraya alındı; ilk kontrol bekleniyor.',"⏳ Calendar queued; waiting for the first check."):msg('⏸ Bu tesis/gün şu an taranmıyor.',"⏸ This facility/day is not being monitored yet."));
  else if(!fresh)lines.push(msg('🔄 Seanslar yenileniyor.',"🔄 Sessions are being refreshed."));
  const ranges=filters.filter(f=>!f.exactTime&&(f.startAfter||f.endBefore));
  if(ranges.length)lines.push(msg('🔔 Tercihin: ',"🔔 Your preference: ")+ranges.map(f=>f.startAfter&&(!f.endBefore||f.endBefore==='23:59')
    ?msg(`${f.startAfter} sonrası`,`After ${f.startAfter}`):f.startAfter&&f.endBefore?`${f.startAfter}–${f.endBefore}`:msg(`${f.endBefore} öncesi`,`Before ${f.endBefore}`)).join(', ')+'.');
  if(definitions&&ranges.length&&!options.some(s=>ranges.some(f=>(!f.startAfter||s.start>=f.startAfter)&&(!f.endBefore||s.start<f.endBefore))))
    lines.push(msg('Bu tarihin seans listesinde tercihine uyan saat yok.',"No known session on this date matches your preference."));
  if(all)lines.push(msg('🔔 Günün tamamı seçili.',"🔔 All sessions for this day are selected."));
  if(store.filtersFor(chatId,id).some(f=>!f.date))rows.push([button(msg('🔕 Eski “her gün” takibini kaldır',"🔕 Remove the old “every day” preference"),`lg:${id}`)]);
  rows.push([home()]);
  return reply(chatId,`${facilityEmoji(f.label)} ${shortFacilityName(f.label)}\n📅 ${shortDateLabel(date)}\n\n${lines.join('\n')}`,rows);
}

export function handlePickerCallback(store,chatId,data,now=Date.now()){
 return withChatLanguage(store,chatId,()=>{
  try{return handlePickerAction(store,chatId,data,now);}
  catch(error){
   if(error.message!=='too many selections')throw error;
   const [,id,day]=data.split(':');return {...sessionMenu(store,chatId,id,expand(day),now),answerText:msg('Tesis başına en fazla 48 seçim.','Maximum 48 selections per facility.')};
  }
 });
}
function handlePickerAction(store,chatId,data,now){
  let match=/^d:(\d{1,4}):(\d{8})$/.exec(data);
  if(match){
    const [,id,day]=match,date=expand(day);
    if(!facility(store,id))return null;
    if(!pickerDates(now).includes(date))return dayMenu(store,chatId,id,now);
    if(store.accessMode==='public'&&(!canSelectFacility(store,id)||!store.state.readerPlan?.dates.includes(date)))return sessionMenu(store,chatId,id,date,now);
    if(!sessionOptions(store,id,date,now).length){
      if(dayFilters(store,chatId,id,date).length)return reply(chatId,msg('Bu günün takibi kaldırılsın mı?','Remove monitoring for this day?')+'\n'+shortDateLabel(date),[
        [button(msg('🗑 Evet, kaldır','🗑 Yes, remove'),`dx:${id}:${day}`,'danger')],
        [button(msg('⬅️ Vazgeç','⬅️ Cancel'),`t:${id}`)],
        [button(msg('🔔 Seçimlerim','🔔 My selections'),'p')]
      ]);
      store.replaceDayFilters(chatId,id,date,[{date,notifyAvailable:true}]);
      const menu=dayMenu(store,chatId,id,now);
      return {...menu,text:msg(`✅ ${shortDateLabel(date)} eklendi · bütün seanslar`,`✅ ${shortDateLabel(date)} added · all sessions`),answerText:msg('✅ Kaydedildi','✅ Saved')};
    }
    return sessionMenu(store,chatId,id,date,now);
  }
  match=/^(da|dx):(\d{1,4}):(\d{8})(?::([01]))?$/.exec(data);
  if(match){
    const [,kind,id,code,desired]=match,date=expand(code);
    if(!facility(store,id))return null;
    if(!pickerDates(now).includes(date))return dayMenu(store,chatId,id,now);
    if(store.accessMode==='public'&&(!canSelectFacility(store,id)||!store.state.readerPlan?.dates.includes(date))&&kind!=='dx'&&desired==='1')return sessionMenu(store,chatId,id,date,now);
    const prior=dayFilters(store,chatId,id,date);
    const next=kind==='dx'?[]:desired==='1'?[{date,notifyAvailable:true}]
      :prior.filter(f=>f.startAfter||f.endBefore).map(cleanFilter);
    store.replaceDayFilters(chatId,id,date,next);
    const menu=kind==='dx'&&!sessionOptions(store,id,date,now).length?dayMenu(store,chatId,id,now):sessionMenu(store,chatId,id,date,now);
    return {...menu,answerText:kind==='dx'||desired==='0'?msg('🗑 Kaldırıldı','🗑 Removed'):msg('✅ Kaydedildi','✅ Saved')};
  }
  match=/^q:(\d{1,4}):(\d{8}):((?:[01]\d|2[0-3])[0-5]\d(?:[01]\d|2[0-3])[0-5]\d):([01])$/.exec(data);
  if(match){
    const [,id,day,code,desired]=match,date=expand(day);
    if(!facility(store,id))return null;
    if(!pickerDates(now).includes(date))return dayMenu(store,chatId,id,now);
    if(store.accessMode==='public'&&(!canSelectFacility(store,id)||!store.state.readerPlan?.dates.includes(date))&&desired==='1')return sessionMenu(store,chatId,id,date,now);
    const start=`${code.slice(0,2)}:${code.slice(2,4)}`,end=`${code.slice(4,6)}:${code.slice(6,8)}`;
    const prior=dayFilters(store,chatId,id,date);
    const same=f=>f.exactTime&&f.startAfter===start&&f.endBefore===end;
    // Old/stale/forged callbacks cannot invent hours. Removing a saved session
    // is still possible after it disappears from the current response.
    const exists=sessionOptions(store,id,date,now).some(s=>s.start===start&&s.end===end);
    if((desired==='0'&&prior.some(same))||(desired==='1'&&exists)){
      let next=prior.filter(f=>f.exactTime).filter(f=>!same(f)).map(cleanFilter);
      if(desired==='1')next.push({date,startAfter:start,endBefore:end,notifyAvailable:true,exactTime:true});
      store.replaceDayFilters(chatId,id,date,next);
    }
    return {...sessionMenu(store,chatId,id,date,now),answerText:desired==='0'?msg('🗑 Kaldırıldı','🗑 Removed'):exists?msg('✅ Kaydedildi','✅ Saved'):msg('Bu saat artık listede yok.','This time is no longer listed.')};
  }
  match=/^lg:(\d{1,4})$/.exec(data);
  if(match&&facility(store,match[1])){
    store.removeUndatedFilters(chatId,match[1]);return dayMenu(store,chatId,match[1],now);
  }
  return null;
}
