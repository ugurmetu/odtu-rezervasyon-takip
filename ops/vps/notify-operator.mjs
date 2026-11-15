// Local Codex monitor sender. Never starts a poller or touches the VPS service.
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {configureOperatorChannel,isOperatorChannel} from '../../src/operator-alerts.mjs';
import {TelegramApi} from '../../src/telegram.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const RETRY_MS=60*60_000;

export function validateNotice(input){
 if(!input||!/^[-a-z0-9_]{1,64}$/.test(input.key||'')||['__proto__','constructor','prototype'].includes(input.key)||!['problem','recovered'].includes(input.state)
   ||typeof input.message!=='string'||!input.message.trim()||input.message.length>2400
   ||/\d{5,}:[A-Za-z0-9_-]{20,}|BEGIN .*PRIVATE KEY|chat_id\s*[:=]|password\s*[:=]|token\s*[:=]/i.test(input.message))
  throw new Error('invalid_notice');
 return {key:input.key,state:input.state,message:input.message.trim()};
}

export async function notifyOperator({input,channel,ownerChatId,stateFile,now=Date.now()}){
 const notice=validateNotice(input);
 if(!isOperatorChannel(channel,ownerChatId))return {ok:false,result:'private_channel_required'};
 mkdirSync(dirname(stateFile),{recursive:true,mode:0o700});
 const lock=stateFile+'.lock';
 try{mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')return {ok:false,result:'busy'};throw e;}
 try{
  let saved={notices:{}};
  try{saved=JSON.parse(readFileSync(stateFile,'utf8'));if(!saved.notices||typeof saved.notices!=='object')throw new Error('invalid_state');}
  catch(e){if(e.code!=='ENOENT')return {ok:false,result:'notice_state_unavailable'};}
  const previous=saved.notices[notice.key];
  if(notice.state==='recovered'&&(!previous||previous.state!=='problem'))return {ok:true,result:'no_open_problem'};
  if(previous?.state===notice.state&&!(previous.delivery==='rejected'&&now-previous.at>=RETRY_MS))
   return {ok:true,result:'duplicate_suppressed'};
  const persist=()=>{
   const temporary=stateFile+'.tmp';
   writeFileSync(temporary,JSON.stringify(saved,null,2)+'\n',{mode:0o600});renameSync(temporary,stateFile);
  };
  // Persist before transport. A timeout/crash must not cause a duplicate send.
  const record={state:notice.state,at:now,delivery:'attempting'};
  saved.notices[notice.key]=record;persist();
  const heading=notice.state==='problem'?'⚠️ ODTÜ Rezervasyon — Kontrol uyarısı':'✅ ODTÜ Rezervasyon — Toparlandı';
  try{
   await channel.sendMessage(ownerChatId,heading+'\n'+notice.message);
   record.delivery='accepted';persist();return {ok:true,result:'accepted'};
  }catch(e){
   record.delivery=[400,401,403,429].includes(e.status)?'rejected':'uncertain';persist();
   return {ok:false,result:record.delivery};
  }
 }finally{rmdirSync(lock);}
}

function readPrivate(name){
 const file=resolve(root,'.local',name),info=statSync(file);
 if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('private_config_unavailable');
 return readFileSync(file,'utf8').trim();
}

async function main(){
 const args=process.argv.slice(2);
 if(args.length>1||(args.length===1&&args[0]!=='--check'))throw new Error('invalid_arguments');
 const check=args[0]==='--check';
 // No caller-supplied token, chat, URL, or environment fallback is accepted.
 const publicToken=readPrivate('telegram-token'),operatorToken=readPrivate('telegram-legacy-token'),ownerChatId=readPrivate('owner-chat-id');
 const route=await configureOperatorChannel({publicToken,operatorToken,ownerChatId,apiFactory:token=>new TelegramApi(token)});
 if(!route.channel)return {ok:false,result:route.reason};
 if(check)return {ok:true,result:'verified_private_operator_channel'};
 return notifyOperator({input:JSON.parse(readFileSync(0,'utf8')),channel:route.channel,ownerChatId,
  stateFile:resolve(root,'.local/operator-monitor-notices.json')});
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const result=await main();console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}
 catch{console.error(JSON.stringify({ok:false,result:'operator_notice_unavailable'}));process.exitCode=1;}
}
