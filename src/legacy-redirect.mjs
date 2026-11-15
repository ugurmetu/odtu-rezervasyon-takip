import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const NEW_BOT='https://t.me/odtu_rezervasyon_bot';
export function redirectReply(update,{operatorOwnerId=null,ownerStats=null}={}){
 const message=update.message||update.callback_query?.message;
 if(message?.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||message.chat.id<1)return null;
 if(update.callback_query?.from?.id && update.callback_query.from.id!==message.chat.id)return null;
 if(String(message.chat.id)===String(operatorOwnerId)){
  // Only the owner's private chat gets statistics; everyone else is redirected.
  const command=String(update.message?.text||'').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if(ownerStats&&['/istatistik','/stats'].includes(command))return {chatId:message.chat.id,text:ownerStats(),owner:true};
  return {chatId:message.chat.id,owner:true,text:'🛠 Rezervasyon yönetimi\nTeknik uyarılar yalnız sana bu özel sohbette iletilir.\n📊 Kullanıcı sayıları için /istatistik yaz.\nKullanıcı botu: @odtu_rezervasyon_bot'};
 }
 return {chatId:message.chat.id,text:'🏟️ ODTÜ Rezervasyon Takip yeni adresine taşındı.\n\nAşağıdan yeni botu açıp Başlat’a bas. Önceki seçimlerin korunuyor.\n'+NEW_BOT,replyMarkup:{inline_keyboard:[[{text:'🏟️ Yeni botu aç',url:NEW_BOT}]]}};
}
export async function runLegacyRedirect(api,file,signal,options={}){
 let offset=0;try{offset=JSON.parse(readFileSync(file,'utf8')).offset||0;}catch(e){if(e.code!=='ENOENT')throw e;}
 const recent=new Map();
 while(!signal.aborted){
  try{
   const updates=await api.call('getUpdates',{offset,timeout:15,allowed_updates:['message','callback_query']},20000);
   for(const update of updates){
    if(!Number.isSafeInteger(update.update_id)||update.update_id<offset)continue;
    offset=update.update_id+1;
    const temp=file+'.tmp';writeFileSync(temp,JSON.stringify({offset}),{mode:0o600});renameSync(temp,file);
    const reply=redirectReply(update,options);if(!reply)continue;
    if(update.callback_query?.id)await api.answerCallbackQuery(update.callback_query.id).catch(()=>{});
    const now=Date.now();if(!reply.owner&&now-(recent.get(reply.chatId)||0)<15000)continue;
    recent.set(reply.chatId,now);if(recent.size>1000)for(const [id,at]of recent)if(now-at>60000)recent.delete(id);
    await api.sendMessage(reply.chatId,reply.text,reply.replyMarkup,5000);
   }
  }catch(error){if(signal.aborted)break;console.error(`Eski bot yönlendirmesi geçici hata: HTTP ${error.status||'network'}`);await delay(Math.max(5000,error.retryAfterMs||0),undefined,{signal}).catch(()=>{});}
 }
}
