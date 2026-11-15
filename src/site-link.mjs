import {withLanguage,msg} from './i18n.mjs';
const SITE='https://rez.metu.edu.tr/';
const validId=id=>Number.isSafeInteger(id)&&id>0;
const plain=markup=>({inline_keyboard:(markup?.inline_keyboard||[]).map(row=>row.filter(b=>b.url!==SITE)).filter(row=>row.length)});

export const siteShortcutText=lang=>withLanguage(lang,()=>msg('🌐 Rezervasyon sitesi','🌐 Reservation website'));
export const siteReplyKeyboard=lang=>({keyboard:[[{text:siteShortcutText(lang),style:'primary'}]],is_persistent:true,resize_keyboard:true,one_time_keyboard:false});
export const siteLinkReply=(chatId,lang)=>({chatId,text:withLanguage(lang,()=>msg('🌐 Rezervasyon / iptal','🌐 Book / cancel'))+'\n'+SITE});
const KEYBOARD_VERSION=1;

// Public-bot transport only. Message text is never edited by this adapter.
// Legacy inline site buttons are removed without delaying or
// retrying a vacancy message if optional UI cleanup fails.
// UI updates are silent: attach the keyboard only to an existing ordinary
// response/alert. Never send a separate setup or introduction message.
export function withFixedSiteShortcut(store,api){
 if(typeof api.editMessageReplyMarkup!=='function')return api;
 const pendingChats=new Set(),legacy=new Map();let timer=null,dirty=false,stopped=false,active=null,retryAt=0;
 for(const a of Object.values(store.state.slotAlerts||{}))if(validId(a.messageId)&&store.state.siteLinks?.[String(a.chatId)]?.keyboardVersion!==KEYBOARD_VERSION){
  const id=String(a.chatId);if(!legacy.has(id))legacy.set(id,new Set());legacy.get(id).add(a.messageId);
 }
 for(const [chat,e] of Object.entries(store.state.siteLinks||{})){
  if(validId(e.latest?.id)){e.pending||={};e.pending[e.latest.id]=e.latest.base||{inline_keyboard:[]};delete e.latest;dirty=true;}
  if(Object.keys(e.pending||{}).length)pendingChats.add(chat);
 }
 function entry(chat){
  store.state.siteLinks||={};
  const e=store.state.siteLinks[chat]||={pending:{}};e.pending||={};
  for(const id of legacy.get(chat)||[])e.pending[id]={inline_keyboard:[]};
  legacy.delete(chat);if(Object.keys(e.pending).length)pendingChats.add(chat);return e;
 }
 function schedule(){if(stopped||timer)return;timer=setTimeout(()=>{timer=null;active=flush().catch(()=>{}).finally(()=>{active=null;if(dirty||pendingChats.size)schedule();});},1000);timer.unref();}
 function rememberKeyboard(chat,lang){
  if(!store.isChatAllowed(chat))return;
  const e=entry(chat);e.keyboardVersion=KEYBOARD_VERSION;e.keyboardLanguage=lang;dirty=true;schedule();
 }
 function busy(){return store.state.outbox.some(x=>['queued','sending'].includes(x.status))||Object.values(store.state.slotStatusJobs||{}).some(j=>j.notify&&['pending','sending'].includes(j.notifyState));}
 function persist(){if(!dirty)return;try{store.save();dirty=false;}catch{console.error('REZ_SITE_LINK persistence_unavailable');}}
 async function flush({force=false,max=8}={}){
  persist();if(stopped||Date.now()<retryAt||(!force&&busy()))return;
  let count=0;
  for(const chat of pendingChats){
   const e=store.state.siteLinks?.[chat];
   if(!e||!store.isChatAllowed(chat)){pendingChats.delete(chat);continue;}
   for(const raw of Object.keys(e.pending||{})){
    if(count>=max||(!force&&busy())){persist();return;}
    const id=Number(raw);
    if(!validId(id)){delete e.pending[raw];dirty=true;continue;}
    try{count++;await api.editMessageReplyMarkup(chat,id,e.pending[raw]);delete e.pending[raw];dirty=true;}
    catch(error){
     if(error.notModified||Number(error.status)>=400&&Number(error.status)<500&&error.status!==429){delete e.pending[raw];dirty=true;}
     else{
      retryAt=Date.now()+Math.max(10000,error.retryAfterMs||30000);
      if(error.status===429)store.deferQueuedUntil(retryAt);
      persist();return;
     }
    }
   }
   if(!Object.keys(e.pending).length)pendingChats.delete(chat);
  }
  persist();
 }
 return new Proxy(api,{get(target,key){
  if(key==='flushSiteLinks')return async options=>{if(active)await active;return flush(options);};
  if(key==='stopSiteLinks')return async()=>{stopped=true;clearTimeout(timer);timer=null;if(active)await active;persist();};
  if(key==='sendMessage')return async(chatId,text,replyMarkup,...rest)=>{
   const chat=String(chatId),eligible=store.isChatAllowed(chat)&&(!replyMarkup||Array.isArray(replyMarkup.inline_keyboard));
   if(!eligible)return target.sendMessage(chatId,text,replyMarkup,...rest);
   const base=plain(replyMarkup),lang=store.languageFor(chat),fixed=base.inline_keyboard.length===0;
   entry(chat);const result=await target.sendMessage(chatId,text,fixed?siteReplyKeyboard(lang):base,...rest);
   if(fixed)rememberKeyboard(chat,lang);else if(pendingChats.has(chat))schedule();
   return result;
  };
  if(key==='editMessageText')return async(chatId,id,text,replyMarkup)=>{
   const chat=String(chatId);if(!store.isChatAllowed(chat))return target.editMessageText(chatId,id,text,replyMarkup);
   const e=entry(chat),base=plain(replyMarkup);
   const result=await target.editMessageText(chatId,id,text,base);
   if(e.pending[id]){delete e.pending[id];dirty=true;schedule();}
   return result;
  };
  if(key==='deleteMessage')return async(chatId,id)=>{
   const result=await target.deleteMessage(chatId,id),e=store.state.siteLinks?.[String(chatId)];
   if(e){delete e.pending?.[id];dirty=true;schedule();}
   return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

// Existing imports remain compatible; the transport now installs a fixed shortcut.
export const withSingleSiteLink=withFixedSiteShortcut;
