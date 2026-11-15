(function(root){
'use strict';
function createReaderClock({chrome,readConfig,onTick,WebSocketImpl=root.WebSocket,setTimeoutImpl=setTimeout,clearTimeoutImpl=clearTimeout}){
 let socket=null,connecting=false,retry=null,stopped=false,backoff=1000;
 function disconnect(){stopped=true;if(retry)clearTimeoutImpl(retry);retry=null;const old=socket;socket=null;old?.close();}
 async function ensure(){
  if(connecting||socket||typeof WebSocketImpl!=='function')return;
  connecting=true;
  try{
   const config=await readConfig();const {paused=true}=await chrome.storage.local.get('paused');
   if(config.fastWatch!==true||config.autoManage!==true||paused){disconnect();return;}
   stopped=false;let authKey=config.key;
   socket=new WebSocketImpl('ws://127.0.0.1:8765/reader-clock','rez-v1');const current=socket;
   current.onopen=()=>{current.send(JSON.stringify({type:'auth',key:authKey,tickMs:1000}));authKey=null;current.onopen=null;backoff=1000;};
   current.onmessage=event=>{
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(message?.type==='tick'&&Number.isFinite(message.at)&&Math.abs(Date.now()-message.at)<30000)void onTick();
   };
   current.onerror=()=>{};
   current.onclose=event=>{if(socket!==current)return;socket=null;if(stopped||event?.code===1008)return;retry=setTimeoutImpl(()=>{retry=null;void ensure();},backoff);backoff=Math.min(backoff*2,30000);};
  }catch{
   if(!stopped&&!retry){retry=setTimeoutImpl(()=>{retry=null;void ensure();},backoff);backoff=Math.min(backoff*2,30000);}
  }finally{connecting=false;}
 }
 return {ensure,disconnect};
}
root.RezReaderClock={createReaderClock};
})(typeof globalThis==='undefined'?self:globalThis);
