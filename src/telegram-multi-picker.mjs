import {randomBytes} from 'node:crypto';
import {msg,withChatLanguage,facilityLabel} from './i18n.mjs';
import {isTennisFacility,canSelectFacility} from './reader-facilities.mjs';
import {pickerDates,sessionOptions,shortFacilityName,shortDateLabel} from './telegram-picker.mjs';

const PAGE=12;
const clip=(text,n=43)=>Array.from(text).length>n?Array.from(text).slice(0,n-1).join('')+'…':text;
const b=(text,callback_data,style)=>({text:clip(text),callback_data,...(style?{style}:{})});
const home=()=>b(msg('🏠 Ana menü','🏠 Main menu'),'h');
const lines=text=>text.split('\n').map(line=>{const words=line.split(' '),out=[];let part='';for(const word of words){if(part&&Array.from(part+' '+word).length>45){out.push(part);part='';}part+=(part?' ':'')+word;}out.push(part);return out.join('\n');}).join('\n');
const reply=(chatId,text,rows,answerText)=>({chatId,text:lines(text),replyMarkup:{inline_keyboard:rows},...(answerText?{answerText}:{})});
const code=s=>s.start.replace(':','')+s.end.replace(':','');
const clock=c=>`${c.slice(0,2)}:${c.slice(2,4)}–${c.slice(4,6)}:${c.slice(6,8)}`;
const compact=d=>d.replaceAll('-','');
const expand=d=>`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
const callback=(d,action)=>`m:${d.id}:${action}`;
const eligible=(store,id)=>{const f=store.catalogFacility(id);return f&&f.enabled!==false&&(store.accessMode!=='public'||canSelectFacility(store,id));};
const unique=values=>[...new Set(values)];
const toggle=(values,value)=>values.includes(value)?values.filter(x=>x!==value):[...values,value];
const toggleGroup=(values,group)=>group.length&&group.every(x=>values.includes(x))?values.filter(x=>!group.includes(x)):unique([...values,...group]);

export function pruneSelectionDrafts(store,now=Date.now()){
 return store.pruneSelectionDrafts(now);
}
function start(store,chatId,now){
 const facilities=store.availableFacilities().filter(f=>eligible(store,f.id));
 const draft={id:randomBytes(6).toString('hex'),stage:'f',facilities:[],dates:[],times:[],allTimes:false,at:now,
  facilityChoices:facilities.map(f=>f.id),units:unique(facilities.map(f=>f.unit)),unit:0,page:0};
 (store.state.selectionDrafts||={})[String(chatId)]=draft;store.save();return draft;
}
function options(store,d,now){
 const times=new Map();
 for(const id of d.facilities)for(const date of d.dates)for(const s of sessionOptions(store,id,date,now))times.set(code(s),s);
 return [...times.keys()].sort();
}
function paginate(d,values,rows,make){
 const pages=Math.max(1,Math.ceil(values.length/PAGE));d.page=Math.max(0,Math.min(d.page,pages-1));
 rows.push(...values.slice(d.page*PAGE,(d.page+1)*PAGE).map(make));
 if(pages>1)rows.push([
  ...(d.page?[b('⬅️',callback(d,`page:${d.page-1}`))]:[]),
  b(`${d.page+1}/${pages}`,callback(d,'noop')),
  ...(d.page+1<pages?[b('➡️',callback(d,`page:${d.page+1}`))]:[])
 ]);
}
function facilitiesMenu(store,chatId,d,answerText){
 const rows=[];
 if(d.units.length>1)for(let i=0;i<d.units.length;i++)rows.push([b(`${i===d.unit?'●':'○'} ${facilityLabel(d.units[i])}`,callback(d,`unit:${i}`),i===d.unit?'success':undefined)]);
 const choices=d.facilityChoices.map((id,index)=>({id,index,f:store.catalogFacility(id)})).filter(x=>eligible(store,x.id)&&x.f.unit===d.units[d.unit]);
 paginate(d,choices,rows,({id,index,f})=>[b(`${d.facilities.includes(id)?'☑️':'▫️'} ${shortFacilityName(f.label)}`,callback(d,`f:${index}`),d.facilities.includes(id)?'success':undefined)]);
 const tennis=d.facilityChoices.filter(id=>eligible(store,id)&&isTennisFacility(store.catalogFacility(id)));
 const fitness=d.facilityChoices.filter(id=>eligible(store,id)&&/fitness/i.test(store.catalogFacility(id).label));
 if(tennis.length)rows.push([b(msg('🎾 Bütün tenis kortları','🎾 All tennis courts'),callback(d,'group:tennis'),tennis.every(id=>d.facilities.includes(id))?'success':undefined)]);
 if(fitness.length)rows.push([b(msg('🏋️ Bütün fitness salonları','🏋️ All fitness centres'),callback(d,'group:fitness'),fitness.every(id=>d.facilities.includes(id))?'success':undefined)]);
 rows.push([b(msg(`Devam ➡️ (${d.facilities.length} tesis)`,`Continue ➡️ (${d.facilities.length} facilities)`),callback(d,d.facilities.length?'next':'noop'),d.facilities.length?'primary':undefined)],[home()]);
 return reply(chatId,msg('⚡ Hızlı seçim · 1/3\nTakip edeceğin tesisleri işaretle.','⚡ Quick selection · 1/3\nChoose the facilities to follow.'),rows,answerText);
}
function daysMenu(store,chatId,d,now,answerText){
 const dates=pickerDates(now),rows=dates.map(date=>[b(`${d.dates.includes(date)?'☑️':'▫️'} ${shortDateLabel(date)}`,callback(d,`d:${compact(date)}`),d.dates.includes(date)?'success':undefined)]);
 rows.push([b(msg('📅 Bütün hafta','📅 Whole week'),callback(d,'week'),dates.every(date=>d.dates.includes(date))?'success':undefined)]);
 rows.push([b(msg(`Devam ➡️ (${d.dates.length} gün)`,`Continue ➡️ (${d.dates.length} days)`),callback(d,d.dates.length?'next':'noop'),d.dates.length?'primary':undefined)]);
 rows.push([b(msg('⬅️ Tesisler','⬅️ Facilities'),callback(d,'back'))],[home()]);
 return reply(chatId,msg('⚡ Hızlı seçim · 2/3\nGitmek istediğin günleri işaretle.','⚡ Quick selection · 2/3\nChoose the days you want to visit.'),rows,answerText);
}
function timesMenu(store,chatId,d,now,answerText){
 const times=options(store,d,now),rows=[];
 paginate(d,times,rows,c=>[b(`${d.allTimes||d.times.includes(c)?'☑️':'▫️'} ${clock(c)}`,callback(d,`t:${c}`),d.allTimes||d.times.includes(c)?'success':undefined)]);
 rows.push([b(msg('🕘 Tüm saatler','🕘 All times'),callback(d,'all'),d.allTimes?'success':undefined)]);
 if(times.some(c=>c.slice(0,4)>='1700'))rows.push([b(msg('🌇 17:00 sonrası','🌇 After 17:00'),callback(d,'evening'),!d.allTimes&&times.filter(c=>c.slice(0,4)>='1700').every(c=>d.times.includes(c))?'success':undefined)]);
 const ready=d.allTimes||d.times.length||!times.length;
 rows.push([b(msg('✅ Kaydet','✅ Save'),callback(d,ready?'save':'noop'),ready?'primary':undefined)]);
 rows.push([b(msg('⬅️ Günler','⬅️ Days'),callback(d,'back'))],[home()]);
 const text=msg('⚡ Hızlı seçim · 3/3\nHaber almak istediğin saatleri işaretle.','⚡ Quick selection · 3/3\nChoose the times you want alerts for.');
 return reply(chatId,text+(!times.length?msg('\n\nBilinen saat yok.\nSeçilen günler bütün gün izlenecek.','\n\nNo times are known yet.\nThe selected days will be watched in full.') :''),rows,answerText);
}
function summary(chatId,d){
 const hours=d.allTimes||!d.times.length?msg('bütün saatler','all times'):msg(`${d.times.length} saat`,`${d.times.length} times`);
 return reply(chatId,msg(`✅ Kaydedildi: ${d.facilities.length} tesis · ${d.dates.length} gün · ${hours}`,`✅ Saved: ${d.facilities.length} facilities · ${d.dates.length} days · ${hours}`),[[b(msg('🔔 Seçimlerim','🔔 My selections'),'p','primary'),home()]]);
}
function render(store,chatId,d,now,answer){
 return d.stage==='f'?facilitiesMenu(store,chatId,d,answer):d.stage==='d'?daysMenu(store,chatId,d,now,answer):d.stage==='saved'?summary(chatId,d):timesMenu(store,chatId,d,now,answer);
}
export function handleMultiPickerCallback(store,chatId,data,now=Date.now()){
 return withChatLanguage(store,chatId,()=>{
  if(!store.isChatAllowed(chatId))return null;
  pruneSelectionDrafts(store,now);
  if(data==='m:start')return facilitiesMenu(store,chatId,start(store,chatId,now));
  const match=/^m:([a-f0-9]{12}):(.{1,35})$/.exec(data),d=store.state.selectionDrafts?.[String(chatId)];
  if(!match||!d||d.id!==match[1])return reply(chatId,msg('Seçim ekranının süresi doldu.','This selection screen has expired.'),[[b(msg('⚡ Yeniden başla','⚡ Start again'),'m:start','primary')],[home()]]);
  const action=match[2];
  if(d.stage==='saved')return summary(chatId,d);
  let answer;
  if(action==='noop')return render(store,chatId,d,now,msg('Önce bir seçim yap.','Choose at least one option.'));
  if(action==='back'){
   d.stage=d.stage==='t'?'d':'f';d.page=0;
  }else if(/^page:\d{1,4}$/.test(action)&&['f','t'].includes(d.stage))d.page=Number(action.slice(5));
  else if(d.stage==='f'){
   if(/^unit:\d{1,2}$/.test(action)&&d.units[Number(action.slice(5))]){d.unit=Number(action.slice(5));d.page=0;}
   else{
    let group;
    if(/^f:\d{1,3}$/.test(action)){
     const id=d.facilityChoices[Number(action.slice(2))];
     if(!eligible(store,id)||store.catalogFacility(id).unit!==d.units[d.unit])return render(store,chatId,d,now);
     d.facilities=toggle(d.facilities,id);
    }else if(['group:tennis','group:fitness'].includes(action)){
     group=d.facilityChoices.filter(id=>eligible(store,id)&&(action==='group:tennis'?isTennisFacility(store.catalogFacility(id)):/fitness/i.test(store.catalogFacility(id).label)));
     d.facilities=toggleGroup(d.facilities,group);
    }else if(action==='next'&&d.facilities.length){d.stage='d';d.page=0;}
    else return render(store,chatId,d,now);
    if(action!=='next'){d.times=[];d.allTimes=false;}
   }
  }else if(d.stage==='d'){
   if(/^d:\d{8}$/.test(action)&&pickerDates(now).includes(expand(action.slice(2)))){d.dates=toggle(d.dates,expand(action.slice(2)));d.times=[];d.allTimes=false;}
   else if(action==='week'){d.dates=toggleGroup(d.dates,pickerDates(now));d.times=[];d.allTimes=false;}
   else if(action==='next'&&d.dates.length){d.stage='t';d.page=0;}
   else return render(store,chatId,d,now);
  }else if(d.stage==='t'){
   const current=options(store,d,now);
   if(/^t:\d{8}$/.test(action)&&current.includes(action.slice(2))){d.allTimes=false;d.times=toggle(d.times,action.slice(2));}
   else if(action==='all'){d.allTimes=!d.allTimes;d.times=[];}
   else if(action==='evening'){d.times=toggleGroup(d.allTimes?[]:d.times,current.filter(c=>c.slice(0,4)>='1700'));d.allTimes=false;}
   else if(action==='save'){
    if(d.facilities.some(id=>!eligible(store,id))){d.facilities=d.facilities.filter(id=>eligible(store,id));d.stage='f';store.save();return render(store,chatId,d,now,msg('Tesisler değişti; yeniden seç.','Facilities changed; choose again.'));}
    if(d.dates.some(date=>!pickerDates(now).includes(date))){d.dates=d.dates.filter(date=>pickerDates(now).includes(date));d.stage='d';store.save();return render(store,chatId,d,now,msg('Günler değişti; yeniden seç.','Dates changed; choose again.'));}
    if(!d.allTimes&&d.times.some(c=>!current.includes(c))){d.times=d.times.filter(c=>current.includes(c));store.save();return render(store,chatId,d,now,msg('Saatler değişti; yeniden seç.','Times changed; choose again.'));}
    if(!d.facilities.length||!d.dates.length||(!d.allTimes&&!d.times.length&&current.length))return render(store,chatId,d,now,msg('Önce bir seçim yap.','Choose at least one option.'));
    const entries=[];
    for(const id of d.facilities)for(const date of d.dates){
     const known=sessionOptions(store,id,date,now);
     const filters=d.allTimes||!known.length?[{date,notifyAvailable:true}]:known.filter(s=>d.times.includes(code(s))).map(s=>({date,startAfter:s.start,endBefore:s.end,notifyAvailable:true,exactTime:true}));
     if(filters.length)entries.push({facilityId:id,date,filters});
    }
    try{store.appendDayFilters(chatId,entries);}catch(error){
     if(error.message!=='too many selections')throw error;
     return render(store,chatId,d,now,msg('Tesis başına en fazla 48 seçim.','Maximum 48 selections per facility.'));
    }
    d.stage='saved';d.at=now;store.save();return summary(chatId,d);
   }else return render(store,chatId,d,now);
  }
  d.at=now;store.save();return render(store,chatId,d,now,answer);
 });
}
