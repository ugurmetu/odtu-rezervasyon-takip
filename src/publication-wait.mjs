// Fresh date-mismatch observations on an unconfirmed future-only Sunday plan
// require publication waiting, not a restart. No slots/freshness are invented.
export function isPublicationWait({state={},engine=state.engine,now=Date.now()}={}){
 if(!['ready','preparing','reconnecting'].includes(state.readerState?.phase)
  ||state.lastDiagnostic!=='calendar_date_mismatch'
  ||engine?.health?.lastState!=='calendar_unavailable')return false;
 const seen=Date.parse(engine.health.lastSeenAt||'');
 if(!Number.isFinite(seen)||now-seen<0||now-seen>180000)return false;
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const today=`${p.year}-${p.month}-${p.day}`,day=Date.parse(today+'T12:00:00Z');
 if(new Date(day).getUTCDay()!==0||`${p.hour}:${p.minute}`<'19:30')return false;
 const dates=state.readerPlan?.dates;
 if(!Array.isArray(dates)||dates.length!==7||!state.readerPlan?.facilityIds?.length)return false;
 if(dates.some((date,i)=>date!==new Date(day+(i+1)*86400000).toISOString().slice(0,10)))return false;
 // A real read of any new-week day ends this exception, including an empty
 // but validated response. Partial coverage then uses the usual diagnostics.
 return !Object.values(engine.pages||{}).some(p=>dates.includes(p?.date)&&Number.isFinite(Date.parse(p.lastSuccessAt||'')));
}
