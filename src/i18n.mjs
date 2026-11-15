import {AsyncLocalStorage} from 'node:async_hooks';

// Rendering context is isolated per chat, including overlapping async sends.
// Persist only the language code; never infer or retain Telegram profile data.
const context=new AsyncLocalStorage();
export const isLanguage=value=>value==='tr'||value==='en';
export const language=()=>context.getStore()||'tr';
export const locale=()=>language()==='en'?'en-GB':'tr-TR';
export const msg=(tr,en)=>language()==='en'?en:tr;
export const withLanguage=(value,render)=>context.run(isLanguage(value)?value:'tr',render);
export const withChatLanguage=(store,chatId,render)=>withLanguage(store.languageFor?.(chatId)||'tr',render);

export function facilityLabel(label=''){
 const raw=String(label);
 if(language()!=='en')return raw;
 const terms=[
  ['Merkez Tenis Kortları','Central Tennis Courts'],['Büyük Spor Salonu','Main Sports Hall'],
  ['ODTÜ Spor Merkezi','METU Sports Centre'],['Baraka Spor Salonu','Baraka Sports Hall'],
  ['Spor Müdürlüğü','Sports Directorate'],['Havuz Müdürlüğü','Swimming Pool Directorate'],
  ['Minder Sporları Salonu','Martial Arts Hall'],['Tırmanma Duvarı','Climbing Wall'],
  ['Fitness Salonu','Fitness'],['Aynalı Salon','Mirrored Studio'],['Ana Salon','Main Hall'],
  ['Kapalı Tenis Kortu','Indoor Tennis Court'],['Açık Tenis Kortu','Outdoor Tennis Court'],
  ['Tenis Kortu','Tennis Court'],['Kapalı Kort','Indoor Court'],['Squash Kortu','Squash Court'],
  ['Padel Kort','Padel Court'],['Pickleball Kort','Pickleball Court'],['Halı Saha','Football Pitch'],
  ['Voleybol','Volleyball'],['Basketbol','Basketball'],['Stadyum','Stadium'],
  [' Nolu ',' '],[' No’lu ',' '],[' No\'lu ',' '],[' Nolu Salon',' Hall'],
  ['Birimi doğrulanmadı','Directorate not verified'],['Nolu Salon','Hall'],['Salon','Hall'],['ODTÜ','METU']
 ];
 return terms.reduce((value,[tr,en])=>value.replaceAll(tr,en),raw);
}
