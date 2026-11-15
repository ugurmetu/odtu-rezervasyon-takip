// Operational notices must never use the public bot, even as a fallback.
const CHANNEL=Symbol('private-operator-channel');
const ownerId=value=>/^[1-9]\d{0,19}$/.test(String(value||''))?String(value):null;

export function createOperatorChannel(api,ownerChatId){
 const owner=ownerId(ownerChatId);
 if(!owner||typeof api?.sendMessage!=='function')throw new Error('invalid_operator_channel');
 return Object.freeze({
  [CHANNEL]:owner,
  async sendMessage(chatId,text){
   if(String(chatId)!==owner)throw new Error('operator_recipient_forbidden');
   return api.sendMessage(owner,text,undefined,10000);
  }
 });
}
export function isOperatorChannel(api,ownerChatId){
 const owner=ownerId(ownerChatId);return !!owner&&api?.[CHANNEL]===owner;
}

export async function configureOperatorChannel({publicToken,operatorToken,ownerChatId,apiFactory}){
 const owner=ownerId(ownerChatId);
 if(!operatorToken||!owner)return {channel:null,reason:'not_configured'};
 if(!publicToken||operatorToken===publicToken)return {channel:null,reason:'public_bot_forbidden'};
 try{
  const api=apiFactory(operatorToken),publicApi=apiFactory(publicToken);
  const [operator,main,chat]=await Promise.all([
   api.call('getMe',{},10000),publicApi.call('getMe',{},10000),api.call('getChat',{chat_id:owner},10000)
  ]);
  if(operator?.is_bot!==true||main?.is_bot!==true||!Number.isSafeInteger(operator.id)||operator.id<1||!Number.isSafeInteger(main.id)||main.id<1
    ||String(operator.id)===String(main.id))return {channel:null,reason:'public_bot_forbidden'};
  if(chat?.type!=='private'||String(chat.id)!==owner)return {channel:null,reason:'private_owner_required'};
  return {channel:createOperatorChannel(api,owner),reason:'ready'};
 }catch{return {channel:null,reason:'verification_unavailable'};}
}
