// Owner-only summary for the private operator bot (/istatistik). Users never
// see it; it reads current totals and aggregate daily counters only.
const dayOf=ms=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date(ms));
// Built from parts: ICU versions differ on "02.11" vs "02/11".
const parts=(ms,o)=>Object.fromEntries(new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',...o}).formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
const label=day=>{const p=parts(Date.parse(`${day}T12:00:00Z`),{day:'2-digit',month:'2-digit',weekday:'short'});return `${p.day}.${p.month} ${p.weekday}`;};
const stamp=ms=>{const p=parts(ms,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});return `${p.day}.${p.month} ${p.hour}:${p.minute}`;};
export function ownerStatsText(state,{now=Date.now(),limit=5000}={}){
 const users=state.betaApprovedChatIds||[],days=state.userStats?.days||{};
 const subs=(state.subscriptions||[]).filter(s=>s.active!==false);
 const lines=[`📊 Kullanıcılar · ${stamp(now)}`,
  `👥 Toplam: ${users.length} / ${limit}`,`🔔 Seçim yapan: ${new Set(subs.map(s=>s.chatId)).size} kişi · ${subs.length} seçim`,'','📅 Son 7 gün (katılan / ayrılan)'];
 for(let i=0;i<7;i++){const day=dayOf(now-i*86400000),d=days[day];lines.push(`${label(day)}: +${d?.joined||0} / −${d?.left||0}`);}
 const first=Object.keys(days).sort()[0];
 lines.push('',`Günlük sayım ${first?label(first):'bugün'} başladı; öncesinde katılanlar yalnız toplamda.`);
 return lines.join('\n');
}
